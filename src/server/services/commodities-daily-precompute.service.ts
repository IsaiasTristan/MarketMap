/**
 * commodities-daily-precompute.service — daily AEGIS forward-curve ingest.
 *
 * Per active curve: fetch the current strip → upsert today's
 * FuturesCurveSnapshot (idempotent, keyed curveId+settleDate) → refresh
 * realized monthly history. Curves with almost no snapshot depth get a
 * one-time ~1Y vintage backfill via MarketData.ForDateRange so the 1W/1M/…
 * comparisons work from day one.
 *
 * Consumed by:
 *   - factor-daily-precompute.service (appended step in the daily chain)
 *   - POST /api/commodities/admin/ingest (admin manual trigger)
 *
 * Auth failures (expired AEGIS token) abort the run and set `authFailed` on
 * the summary — never silently absorbed. Everything else is per-curve
 * fault-isolated into `failed[]`.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import { AegisAuthError } from "@/infrastructure/providers/aegis/aegis-client";
import { AegisOdataCurveProvider } from "@/infrastructure/providers/aegis/aegis-curve-provider";
import type { CurveRef, FuturesCurveProvider } from "@/infrastructure/providers/futures-curve";
import { addMonths, monthKeyFromIso } from "@/lib/commodities/format";
import type { CommoditiesIngestSummary, CurvePoint } from "@/types/commodities";
import { ensureCommodityCurvesSeeded } from "./commodity-seed.service";
import { withIngestLock } from "./ingest-inflight";

/** Curves with fewer snapshots than this get the one-time vintage backfill. */
const BACKFILL_THRESHOLD = 20;
/** Calendar days of vintage history to backfill (≈ 251 trading days + buffer). */
const BACKFILL_CALENDAR_DAYS = 370;
/** Months of realized history maintained for the bridge (2Y window + buffer). */
const HISTORY_MONTHS = 26;

export const COMMODITIES_INGEST_LOCK_KEY = "commodities:daily";

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toDbDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

async function upsertSnapshot(
  curveId: string,
  settleDate: string,
  points: CurvePoint[],
  source: string,
): Promise<void> {
  const json = points as unknown as Prisma.InputJsonValue;
  await prisma.futuresCurveSnapshot.upsert({
    where: { curveId_settleDate: { curveId, settleDate: toDbDate(settleDate) } },
    create: { curveId, settleDate: toDbDate(settleDate), points: json, source },
    update: { points: json, source, computedAt: new Date() },
  });
}

export interface CommoditiesIngestOptions {
  /** Force the vintage backfill even for curves above the threshold. */
  forceBackfill?: boolean;
  log?: (msg: string) => void;
}

export async function runCommoditiesDailyPrecompute(
  opts: CommoditiesIngestOptions = {},
): Promise<CommoditiesIngestSummary> {
  const log = opts.log ?? ((m: string) => console.log(`[commodities-ingest] ${m}`));
  const startedAt = new Date().toISOString();
  const summary: CommoditiesIngestSummary = {
    startedAt,
    finishedAt: startedAt,
    curves: 0,
    snapshotsUpserted: 0,
    historyMonthsUpserted: 0,
    backfilledCurves: [],
    failed: [],
    authFailed: false,
  };

  await ensureCommodityCurvesSeeded(prisma);
  const provider: FuturesCurveProvider = new AegisOdataCurveProvider();
  const curves = await prisma.commodityCurve.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  summary.curves = curves.length;

  let firstCurve = true;
  for (const curve of curves) {
    // Pace the sweep — AEGIS rate-limits bursty multi-curve pulls (observed
    // 429s mid-backfill). The per-call gaps live in the provider; this is the
    // between-curve breather.
    if (!firstCurve) await new Promise((r) => setTimeout(r, 750));
    firstCurve = false;
    const ref: CurveRef = {
      code: curve.code,
      providerSymbolRoot: curve.providerSymbolRoot,
      unitScale: curve.unitScale,
    };
    try {
      // 1. Latest strip.
      const latest = await provider.fetchCurve(ref);
      if (latest.kind === "error") {
        summary.failed.push({ code: curve.code, error: latest.reason });
        continue;
      }
      if (latest.kind === "empty") {
        summary.failed.push({
          code: curve.code,
          error: `AEGIS returned no strip for product code '${curve.providerSymbolRoot}' (silent-empty)`,
        });
        continue;
      }
      await upsertSnapshot(curve.id, latest.settleDate, latest.points, "AEGIS_ODATA");
      summary.snapshotsUpserted += 1;

      // 2. One-time vintage backfill for shallow curves.
      const snapshotCount = await prisma.futuresCurveSnapshot.count({ where: { curveId: curve.id } });
      if (opts.forceBackfill || snapshotCount < BACKFILL_THRESHOLD) {
        const from = isoAddDays(latest.settleDate, -BACKFILL_CALENDAR_DAYS);
        log(`${curve.code}: backfilling vintages ${from} → ${latest.settleDate}`);
        const vintages = await provider.fetchCurveRange(ref, from, latest.settleDate);
        for (const [settleDate, points] of vintages) {
          if (points.length === 0) continue;
          await upsertSnapshot(curve.id, settleDate, points, "AEGIS_ODATA");
          summary.snapshotsUpserted += 1;
        }
        summary.backfilledCurves.push(curve.code);
        log(`${curve.code}: backfilled ${vintages.size} vintages`);
      }

      // 3. Realized monthly history for the bridge.
      const fromMonth = addMonths(monthKeyFromIso(latest.settleDate), -HISTORY_MONTHS);
      const history = await provider.fetchRealizedMonthly(ref, fromMonth, latest.settleDate);
      for (const h of history) {
        await prisma.commodityHistoryMonthly.upsert({
          where: { curveId_month: { curveId: curve.id, month: h.month } },
          create: { curveId: curve.id, month: h.month, avgSettle: h.avgSettle, source: "AEGIS_ODATA" },
          update: { avgSettle: h.avgSettle, source: "AEGIS_ODATA" },
        });
        summary.historyMonthsUpserted += 1;
      }
    } catch (e) {
      if (e instanceof AegisAuthError) {
        summary.authFailed = true;
        summary.failed.push({ code: curve.code, error: e.message });
        log(`AUTH FAILURE — aborting run: ${e.message}`);
        break; // an expired token fails every curve; don't spam AEGIS
      }
      summary.failed.push({ code: curve.code, error: e instanceof Error ? e.message : String(e) });
    }
  }

  summary.finishedAt = new Date().toISOString();
  log(
    `done: ${summary.snapshotsUpserted} snapshots, ${summary.historyMonthsUpserted} history months, ` +
      `${summary.failed.length} failed${summary.authFailed ? " (AUTH FAILED — refresh AEGIS_ODATA_TOKEN)" : ""}`,
  );
  return summary;
}

/** Lock-guarded entry point shared by the daily chain and the admin route. */
export async function runCommoditiesDailyPrecomputeLocked(
  opts: CommoditiesIngestOptions = {},
): Promise<{ deduped: boolean; summary: CommoditiesIngestSummary | null }> {
  const outcome = await withIngestLock(COMMODITIES_INGEST_LOCK_KEY, () =>
    runCommoditiesDailyPrecompute(opts),
  );
  return outcome.ran ? { deduped: false, summary: outcome.result } : { deduped: true, summary: null };
}
