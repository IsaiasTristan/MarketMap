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
import { ensureCommodityCurvesSeeded, importAegisCatalog } from "./commodity-seed.service";
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
  /** Re-import the full AEGIS Underlyings catalog into the registry. */
  importCatalog?: boolean;
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
  // One-time full-catalog import so the directory covers every AEGIS product
  // (imported curves stay inactive until first used). Also refreshable via
  // the admin route's { catalog: true } flag.
  try {
    const registrySize = await prisma.commodityCurve.count();
    if (opts.importCatalog || registrySize < 50) {
      const cat = await importAegisCatalog(prisma);
      log(`catalog: ${cat.fetched} fetched, ${cat.imported} imported, ${cat.updated} updated, ${cat.skipped.length} skipped`);
    }
  } catch (e) {
    if (e instanceof AegisAuthError) throw e;
    log(`catalog import failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
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

/**
 * On-demand single-curve ingest — fired when a user adds a directory-only
 * (inactive) curve to a set. Fetches the latest strip synchronously-ish so
 * the chart populates within seconds, then the ~1Y vintage backfill and
 * realized history. Per-curve lock so repeated adds don't stampede AEGIS.
 */
export async function ingestSingleCurve(code: string): Promise<void> {
  await withIngestLock(`commodities:curve:${code}`, async () => {
    const curve = await prisma.commodityCurve.findUnique({ where: { code } });
    if (!curve) return;
    const provider: FuturesCurveProvider = new AegisOdataCurveProvider();
    const ref: CurveRef = {
      code: curve.code,
      providerSymbolRoot: curve.providerSymbolRoot,
      unitScale: curve.unitScale,
    };
    const log = (m: string) => console.log(`[commodities-curve-ingest] ${m}`);
    try {
      const latest = await provider.fetchCurve(ref);
      if (latest.kind !== "ok") {
        log(`${code}: no strip (${latest.kind === "error" ? latest.reason : "silent-empty"})`);
        return;
      }
      await upsertSnapshot(curve.id, latest.settleDate, latest.points, "AEGIS_ODATA");

      const from = isoAddDays(latest.settleDate, -BACKFILL_CALENDAR_DAYS);
      const vintages = await provider.fetchCurveRange(ref, from, latest.settleDate);
      for (const [settleDate, points] of vintages) {
        if (points.length === 0) continue;
        await upsertSnapshot(curve.id, settleDate, points, "AEGIS_ODATA");
      }

      const fromMonth = addMonths(monthKeyFromIso(latest.settleDate), -HISTORY_MONTHS);
      const history = await provider.fetchRealizedMonthly(ref, fromMonth, latest.settleDate);
      for (const h of history) {
        await prisma.commodityHistoryMonthly.upsert({
          where: { curveId_month: { curveId: curve.id, month: h.month } },
          create: { curveId: curve.id, month: h.month, avgSettle: h.avgSettle, source: "AEGIS_ODATA" },
          update: { avgSettle: h.avgSettle, source: "AEGIS_ODATA" },
        });
      }
      log(`${code}: latest + ${vintages.size} vintages + ${history.length} history months`);
    } catch (e) {
      log(`${code}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
