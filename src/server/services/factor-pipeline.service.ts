/**
 * factor-pipeline.service — orchestrates the full factor data pipeline.
 *
 * Sources:
 *   Layer 1: Ken French published data (official, ~30-45 day lag)
 *   Layer 2: ETF proxies via Yahoo for gap period
 *
 * ETF proxy mapping (per spec):
 *   Mkt-RF: SPY return − RF (RF stored as daily simple decimal)
 *   SMB:    IWM − SPY
 *   HML:    IVE − IVW
 *   MOM:    MTUM (mean-adjusted)
 *   RMW:    QUAL (mean-adjusted)
 *   CMA:    SPHQ − SPGP
 */

import { prisma as db } from "@/infrastructure/db/client";
import { fetchFf5Factors, fetchMomFactor } from "@/infrastructure/providers/ken-french.provider";
import { fetchYahooChartDaily } from "@/infrastructure/providers/yahoo-chart-http";
import { fetchDgs1moRfDaily, type FredObservation } from "@/infrastructure/providers/fred.provider";
import {
  detectGap,
  normalizeProxyToFf,
  buildFactorSeries,
  calibrateRfShift,
  type FactorSeries,
} from "@/domain/calculations/factor-pipeline";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";
import { writeAuditLog } from "./audit.service";

// Proxy ETFs per spec
const PROXY_ETFS = ["SPY", "IWM", "IVE", "IVW", "MTUM", "QUAL", "SPHQ", "SPGP"];

/**
 * Walk Mon-Fri trading dates strictly after `afterIso` up to and including
 * today (UTC midnight), returning ISO YYYY-MM-DD strings ascending.
 *
 * Mirrors the convention used by `detectGap` and `detectFactorStaleness`:
 * no US-holiday calendar (acceptable when paired with forward-fill of the
 * FRED source over the resulting ~7-12 holiday days/year).
 */
/**
 * Walks Mon-Fri ISO dates strictly after `afterIso` up to (and including)
 * today's UTC date.
 *
 * Implementation note (2026-04-26): the previous version mixed `getDay()`
 * (local-time day-of-week) with `toISOString().slice(0, 10)` (UTC date).
 * On any machine running in a timezone west of UTC, that combination
 * silently writes phantom Saturday rows and skips real Mondays — the
 * Date constructed from `"2026-02-27"` is UTC midnight, which is Feb 26
 * 19:00 EST, so `getDay()` returns Thursday but `toISOString()` returns
 * "2026-02-27" (Friday UTC). After one `setDate()` increment the local
 * day becomes Friday but the UTC date becomes Saturday. To avoid the
 * skew entirely, walk dates using UTC-aware methods only.
 */
function tradingDatesAfter(afterIso: string): string[] {
  const out: string[] = [];
  if (!afterIso) return out;
  const cur = new Date(`${afterIso}T00:00:00.000Z`);
  const today = new Date();
  const todayUtc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  cur.setUTCDate(cur.getUTCDate() + 1);
  while (cur <= todayUtc) {
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * For each ISO target date, look up the latest FRED observation on or
 * before that date (forward-fill across bond-market holidays / null
 * prints). Returns NaN if `target` precedes every observation.
 *
 * Observations must be sorted ascending by date (FRED CSV is by default).
 */
function fredForwardFill(observations: FredObservation[], targets: string[]): Map<string, number> {
  const out = new Map<string, number>();
  let i = 0;
  let lastValue: number | null = null;
  for (const t of targets) {
    while (i < observations.length && observations[i].date <= t) {
      lastValue = observations[i].value;
      i++;
    }
    if (lastValue !== null) out.set(t, lastValue);
  }
  return out;
}

async function fetchEtfDailyReturns(
  ticker: string,
  startIso: string,
  endIso: string,
): Promise<Map<string, number>> {
  const bars = await fetchYahooChartDaily(ticker, startIso, endIso);
  const prices = bars.map((b) => b.adjClose);
  const dates = bars.slice(1).map((b) => b.date);
  const rets = dailyReturnsFromAdjustedCloses(prices);
  const out = new Map<string, number>();
  dates.forEach((d, i) => out.set(d, rets[i] ?? 0));
  return out;
}

function toFactorSeries(map: Map<string, number>): FactorSeries[] {
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }));
}

function computeProxyFactor(
  a: Map<string, number>,
  b?: Map<string, number>,
  rfDaily?: Map<string, number>,
  mode: "A_minus_rf" | "A_minus_B" | "A_alone" = "A_alone",
): Map<string, number> {
  const dates = [...a.keys()];
  const out = new Map<string, number>();
  for (const d of dates) {
    const va = a.get(d) ?? 0;
    if (mode === "A_minus_rf") {
      out.set(d, va - (rfDaily?.get(d) ?? 0));
    } else if (mode === "A_minus_B") {
      out.set(d, va - (b?.get(d) ?? 0));
    } else {
      out.set(d, va);
    }
  }
  return out;
}

export async function refreshFactorPipeline(): Promise<{
  backfilled: boolean;
  newFrenchDate: string | null;
  gapTradingDays: number;
  rfRowsBackfilled: number;
}> {
  // 1. Get existing pipeline status
  const status = await db.factorPipelineStatus.findFirst();
  const lastFrenchDate = status?.lastFrenchDate?.toISOString().slice(0, 10) ?? null;

  // 2. Download FF data
  const [ff5Rows, momRows] = await Promise.all([fetchFf5Factors(), fetchMomFactor()]);

  if (!ff5Rows.length) throw new Error("FF5 data empty");

  const newLastFrenchDate = ff5Rows[ff5Rows.length - 1].date;
  const backfilled = lastFrenchDate !== null && newLastFrenchDate > lastFrenchDate;
  const { gapTradingDays } = detectGap(newLastFrenchDate);

  // 3. Write FF rows to DB (upsert)
  const ffFactorMap: Record<string, { mktRf: number; smb: number; hml: number; rmw: number; cma: number; rf: number }> = {};
  for (const r of ff5Rows) ffFactorMap[r.date] = r;
  const momMap: Record<string, number> = {};
  for (const r of momRows) momMap[r.date] = r.mom;

  // Batch upsert FF factors
  type FactorUpsertRow = { tradeDate: Date; factorCode: "MKT_RF" | "SMB" | "HML" | "RMW" | "CMA" | "MOM" | "RF"; value: number; source: "FF" | "PROXY" };
  const ffUpserts: FactorUpsertRow[] = ff5Rows.flatMap((r) => {
    const mom = momMap[r.date];
    const rows: FactorUpsertRow[] = [
      { tradeDate: new Date(r.date), factorCode: "MKT_RF", value: r.mktRf, source: "FF" },
      { tradeDate: new Date(r.date), factorCode: "SMB", value: r.smb, source: "FF" },
      { tradeDate: new Date(r.date), factorCode: "HML", value: r.hml, source: "FF" },
      { tradeDate: new Date(r.date), factorCode: "RMW", value: r.rmw, source: "FF" },
      { tradeDate: new Date(r.date), factorCode: "CMA", value: r.cma, source: "FF" },
      { tradeDate: new Date(r.date), factorCode: "RF", value: r.rf, source: "FF" },
    ];
    if (mom !== undefined) {
      rows.push({ tradeDate: new Date(r.date), factorCode: "MOM", value: mom, source: "FF" });
    }
    return rows;
  });

  for (const row of ffUpserts) {
    await db.factorReturnDaily.upsert({
      where: { tradeDate_factorCode: { tradeDate: row.tradeDate, factorCode: row.factorCode } },
      create: row,
      update: { value: row.value, source: row.source },
    });
  }

  // 3b. Back-fill RF from FRED DGS1MO for every Mon-Fri date strictly
  //     after the last KF print, up to today. This keeps `rfByDate` in
  //     `factor-engine` / `factor-per-stock(-timeseries)` populated for
  //     the post-KF tail so excess returns aren't silently inflated by
  //     the `rfByDate.get(d) ?? 0` fallback. Stored as PROXY in the
  //     same daily-simple-decimal convention as KF's RF column (every
  //     code in `FactorReturnDaily` is a daily simple return).
  let rfFromFred = new Map<string, number>(); // date -> daily simple decimal
  let rfRowsBackfilled = 0;
  let rfCalibrationShift = 0;
  let rfCalibrationOverlap = 0;
  try {
    const targetRfDates = tradingDatesAfter(newLastFrenchDate);
    if (targetRfDates.length > 0) {
      // Pull a comfortable 90-day-pre-cutoff window so the calibration
      // overlap step has plenty of business-day matches.
      const fredStart = ff5Rows[Math.max(0, ff5Rows.length - 90)]?.date ?? newLastFrenchDate;
      const dgs1moAnnual = await fetchDgs1moRfDaily(fredStart);

      // Convert FRED's annualized decimal to daily simple decimal so the
      // calibration operates on commensurate units with KF (also daily).
      // Linear /252 matches KF Ibbotson's effective convention closely
      // enough that the residual shift below is just the persistent
      // 1-3 bp from 360 vs 365 day count + Ibbotson construction.
      const dgs1moDaily = dgs1moAnnual.map((r) => ({ date: r.date, value: r.value / 252 }));

      // Mean-shift daily-FRED to daily-KF over the trailing 63d overlap
      // so the splice on `newLastFrenchDate + 1` doesn't introduce a
      // discrete jump.
      const ffRfSeries = ff5Rows.map((r) => ({ date: r.date, value: r.rf }));
      const cal = calibrateRfShift(ffRfSeries, dgs1moDaily, newLastFrenchDate);
      rfCalibrationShift = cal.shift;
      rfCalibrationOverlap = cal.overlapDays;

      const dgs1moCalibrated = dgs1moDaily.map((r) => ({
        date: r.date,
        value: r.value + rfCalibrationShift,
      }));
      rfFromFred = fredForwardFill(dgs1moCalibrated, targetRfDates);
      for (const [d, v] of rfFromFred) {
        await db.factorReturnDaily.upsert({
          where: {
            tradeDate_factorCode: { tradeDate: new Date(d), factorCode: "RF" },
          },
          create: {
            tradeDate: new Date(d),
            factorCode: "RF",
            value: v,
            source: "PROXY",
          },
          update: { value: v, source: "PROXY" },
        });
        rfRowsBackfilled++;
      }
    }
  } catch (err) {
    // FRED outage shouldn't fail the whole pipeline; the existing
    // staleness banner will continue to surface the missing RF tail.
    console.error("[factor-pipeline] FRED DGS1MO back-fill failed:", err);
  }

  // 4. If gap exists, fetch proxy ETFs and write normalized gap rows
  if (gapTradingDays > 0) {
    const gapStart = newLastFrenchDate;
    const today = new Date().toISOString().slice(0, 10);

    const [spyRet, iwmRet, iveRet, ivwRet, mtumRet, qualRet, sphqRet, spgpRet] = await Promise.all(
      ["SPY", "IWM", "IVE", "IVW", "MTUM", "QUAL", "SPHQ", "SPGP"].map((t) =>
        fetchEtfDailyReturns(t, gapStart, today),
      ),
    );

    // SPY-RF proxy input: per-date FRED RF where available, else last
    // KF level. Both sides are daily simple decimal so the subtraction
    // SPY_daily − rfDaily is unit-correct. `normalizeProxyToFf`
    // re-centres on the FF tail anyway so any small residual offset is
    // absorbed.
    const latestRf = ff5Rows[ff5Rows.length - 1].rf;
    const rfDaily = new Map<string, number>();
    for (const d of spyRet.keys()) rfDaily.set(d, rfFromFred.get(d) ?? latestRf);

    // Build proxy factor maps
    const proxyMktRf = computeProxyFactor(spyRet, undefined, rfDaily, "A_minus_rf");
    const proxySmb = computeProxyFactor(iwmRet, spyRet, undefined, "A_minus_B");
    const proxyHml = computeProxyFactor(iveRet, ivwRet, undefined, "A_minus_B");
    const proxyMom = computeProxyFactor(mtumRet, undefined, undefined, "A_alone");
    const proxyRmw = computeProxyFactor(qualRet, undefined, undefined, "A_alone");
    const proxyCma = computeProxyFactor(sphqRet, spgpRet, undefined, "A_minus_B");

    // Normalize each proxy against FF calibration window (63d)
    const factorDefs: Array<{
      code: "MKT_RF" | "SMB" | "HML" | "MOM" | "RMW" | "CMA";
      ffSeries: FactorSeries[];
      proxySeries: FactorSeries[];
    }> = [
      { code: "MKT_RF", ffSeries: ff5Rows.map((r) => ({ date: r.date, value: r.mktRf })), proxySeries: toFactorSeries(proxyMktRf) },
      { code: "SMB", ffSeries: ff5Rows.map((r) => ({ date: r.date, value: r.smb })), proxySeries: toFactorSeries(proxySmb) },
      { code: "HML", ffSeries: ff5Rows.map((r) => ({ date: r.date, value: r.hml })), proxySeries: toFactorSeries(proxyHml) },
      { code: "MOM", ffSeries: momRows.map((r) => ({ date: r.date, value: r.mom })), proxySeries: toFactorSeries(proxyMom) },
      { code: "RMW", ffSeries: ff5Rows.map((r) => ({ date: r.date, value: r.rmw })), proxySeries: toFactorSeries(proxyRmw) },
      { code: "CMA", ffSeries: ff5Rows.map((r) => ({ date: r.date, value: r.cma })), proxySeries: toFactorSeries(proxyCma) },
    ];

    for (const fd of factorDefs) {
      const normalized = normalizeProxyToFf(fd.ffSeries, fd.proxySeries, newLastFrenchDate);
      for (const row of normalized) {
        await db.factorReturnDaily.upsert({
          where: {
            tradeDate_factorCode: {
              tradeDate: new Date(row.date),
              factorCode: fd.code,
            },
          },
          create: {
            tradeDate: new Date(row.date),
            factorCode: fd.code,
            value: row.value,
            source: "PROXY",
          },
          update: { value: row.value, source: "PROXY" },
        });
      }
    }
  }

  // 5. Update pipeline status
  const activeProxies =
    gapTradingDays > 0 || rfRowsBackfilled > 0
      ? { etfs: PROXY_ETFS, rf: rfRowsBackfilled > 0 ? "FRED:DGS1MO" : undefined }
      : {};
  await db.factorPipelineStatus.upsert({
    where: { id: status?.id ?? "singleton" },
    create: {
      id: "singleton",
      lastFrenchDate: new Date(newLastFrenchDate),
      gapTradingDays,
      activeProxiesJson: activeProxies,
      lastRefreshAt: new Date(),
    },
    update: {
      lastFrenchDate: new Date(newLastFrenchDate),
      gapTradingDays,
      activeProxiesJson: activeProxies,
      lastRefreshAt: new Date(),
    },
  });

  await writeAuditLog("factor.pipeline.refresh", {
    newLastFrenchDate,
    gapTradingDays,
    backfilled,
    rfRowsBackfilled,
    rfCalibrationShift,
    rfCalibrationOverlap,
  });

  return { backfilled, newFrenchDate: newLastFrenchDate, gapTradingDays, rfRowsBackfilled };
}

export async function getPipelineStatus() {
  const status = await db.factorPipelineStatus.findFirst();
  return {
    lastFrenchDate: status?.lastFrenchDate?.toISOString().slice(0, 10) ?? null,
    gapTradingDays: status?.gapTradingDays ?? null,
    activeProxies: status?.activeProxiesJson ?? null,
    lastRefreshAt: status?.lastRefreshAt?.toISOString() ?? null,
  };
}

/** Fetch the full factor return series from DB for use in attribution. */
export async function getFactorReturnSeries(
  startDate?: string,
): Promise<Map<string, Record<string, number>>> {
  const rows = await db.factorReturnDaily.findMany({
    where: startDate ? { tradeDate: { gte: new Date(startDate) } } : undefined,
    orderBy: { tradeDate: "asc" },
  });

  const out = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const d = row.tradeDate.toISOString().slice(0, 10);
    if (!out.has(d)) out.set(d, {});
    out.get(d)![row.factorCode] = Number(row.value);
  }
  return out;
}
