/**
 * Engine 3 — pattern base rates + calibration sweep (Part 4 / Part 3e).
 *
 * Loops the persisted lifecycle stages, stasis-break events, and (for the sweep)
 * re-scored Core Holdings boards through the pure forward-return core. Returns
 * are split-adjusted (adjClose) EXCESS vs the SP500, and entry timing is the
 * 13F availability date (period-end + settlement lag), never the period-end
 * itself — so there is no lookahead. Cohorts with N < 30 persist as insufficient.
 *
 * Persists InstitutionalBaseRate rows: one per (pattern, horizon) for the
 * lifecycle stages + stasis_break, and one per (calib:long_hold_mult=θ, 2Q) for
 * the Part 3e sweep.
 */
import { prisma } from "@/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import {
  forwardExcessReturn,
  priceAsOf,
  stageEntryEpisodes,
  summarizeCohort,
  type CohortSummary,
  type PricePoint,
} from "@/domain/calculations/base-rates";
import {
  fundMedianTenure,
  scoreEndorsement,
  tenureMult,
  type TenurePoint,
  type Voter,
  CORE_HOLDINGS_CONFIG as CFG,
} from "@/domain/calculations/core-holdings";

const iso = (d: Date | string): string => (typeof d === "string" ? d : d.toISOString()).slice(0, 10);
const DAY = 86_400_000;
/** 13F settlement/availability lag past period-end (matches the ingest window). */
const AVAIL_LAG_DAYS = 46;
const HORIZONS: Array<{ key: string; days: number }> = [
  { key: "1Q", days: 91 },
  { key: "2Q", days: 182 },
];
const BENCHMARK = "SP500";

interface CohortEntry {
  pattern: string;
  ticker: string;
  entryMs: number; // availability date (period-end + lag)
}

/** Availability date (ms) for a quarter-end period string. */
function availabilityMs(periodEnd: string): number {
  return new Date(`${periodEnd}T00:00:00.000Z`).getTime() + AVAIL_LAG_DAYS * DAY;
}

export async function runBaseRates(log: (m: string) => void): Promise<{ patterns: number }> {
  // ── Price series: securities for every ticker we will need + the benchmark. ──
  const entries: CohortEntry[] = [];

  // Lifecycle stage cohorts — EVENT-based (Part 4): one entry per ENTRY EPISODE into
  // a stage, NOT one per quarter the name sits in it (which inflates N and serially-
  // correlates the cohort). WATCH is a sub-scale pre-stage, not a cohort.
  const periodRows0 = await prisma.$queryRaw<Array<{ p: Date }>>(Prisma.sql`
    SELECT DISTINCT "filingPeriod" AS p FROM "InstitutionalNameAggregate" ORDER BY p ASC`);
  const allPeriods = periodRows0.map((r) => iso(r.p));
  const stageRows = await prisma.institutionalNameAggregate.findMany({
    where: { lifecycleStage: { notIn: ["WATCH"] } },
    select: { ticker: true, filingPeriod: true, lifecycleStage: true },
  });
  const stageByTicker = new Map<string, Map<string, string>>();
  for (const r of stageRows) {
    if (!r.lifecycleStage) continue;
    const byP = stageByTicker.get(r.ticker) ?? stageByTicker.set(r.ticker, new Map()).get(r.ticker)!;
    byP.set(iso(r.filingPeriod), r.lifecycleStage);
  }
  for (const [ticker, byP] of stageByTicker) {
    const series = allPeriods.map((p) => byP.get(p) ?? null);
    for (const ep of stageEntryEpisodes(series)) {
      entries.push({ pattern: ep.stage, ticker, entryMs: availabilityMs(allPeriods[ep.index]!) });
    }
  }

  // Stasis-break cohort.
  const stasisRows = await prisma.institutionalEvent.findMany({
    where: { kind: "stasis_break" },
    select: { ticker: true, filingPeriod: true },
  });
  for (const r of stasisRows) entries.push({ pattern: "stasis_break", ticker: r.ticker, entryMs: availabilityMs(iso(r.filingPeriod)) });

  // ── Calibration sweep entries (Part 3e): re-score the board at each θ. ──
  const sweep = await buildCalibrationEntries(log);
  entries.push(...sweep);

  if (entries.length === 0) {
    log("[institutional-agg] base rates: no cohort entries");
    return { patterns: 0 };
  }

  // Load price series for the involved tickers + the benchmark. Bounded to the
  // cohort's date span and chunked by security: an unbounded multi-million-row
  // findMany overflows the Prisma napi bridge ("Failed to convert rust String").
  const tickers = [...new Set(entries.map((e) => e.ticker))];
  const secs = await prisma.security.findMany({ where: { ticker: { in: tickers } }, select: { id: true, ticker: true } });
  const secIdByTicker = new Map(secs.map((s) => [s.ticker, s.id]));
  const priceBySec = new Map<string, PricePoint[]>();
  const minEntryMs = Math.min(...entries.map((e) => e.entryMs));
  const fromDate = new Date(minEntryMs - 7 * DAY);
  const SEC_CHUNK = 120;
  const secIds = secs.map((s) => s.id);
  for (let i = 0; i < secIds.length; i += SEC_CHUNK) {
    const batch = secIds.slice(i, i + SEC_CHUNK);
    const prices = await prisma.priceHistory.findMany({
      where: { securityId: { in: batch }, tradeDate: { gte: fromDate } },
      select: { securityId: true, tradeDate: true, adjClose: true },
      orderBy: { tradeDate: "asc" },
    });
    for (const p of prices) {
      const px = Number(p.adjClose);
      if (!Number.isFinite(px) || px <= 0) continue;
      (priceBySec.get(p.securityId) ?? priceBySec.set(p.securityId, []).get(p.securityId)!).push({ t: p.tradeDate.getTime(), px });
    }
  }
  const bench = await loadBenchmark();

  // ── Accumulate excess returns per (pattern, horizon). ──
  const buckets = new Map<string, number[]>(); // `${pattern}|${horizon}` → excess[]
  for (const e of entries) {
    const secId = secIdByTicker.get(e.ticker);
    const series = secId ? priceBySec.get(secId) : undefined;
    if (!series || !bench) continue;
    const entryPx = priceAsOf(series, e.entryMs);
    const benchEntry = priceAsOf(bench, e.entryMs);
    if (entryPx == null || benchEntry == null) continue;
    for (const h of HORIZONS) {
      const exitMs = e.entryMs + h.days * DAY;
      const exitPx = priceAsOf(series, exitMs);
      const benchExit = priceAsOf(bench, exitMs);
      const ex = exitPx != null && benchExit != null ? forwardExcessReturn(entryPx, exitPx, benchEntry, benchExit) : null;
      const key = `${e.pattern}|${h.key}`;
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(ex ?? NaN);
    }
  }

  // ── Persist. ──
  let written = 0;
  for (const [key, excess] of buckets) {
    const [pattern, horizon] = key.split("|");
    const s: CohortSummary = summarizeCohort(excess);
    await prisma.institutionalBaseRate.upsert({
      where: { pattern_horizon_benchmark: { pattern: pattern!, horizon: horizon!, benchmark: BENCHMARK } },
      create: { pattern: pattern!, horizon: horizon!, benchmark: BENCHMARK, excessReturn: s.excessReturn, hitRate: s.hitRate, n: s.n },
      update: { excessReturn: s.excessReturn, hitRate: s.hitRate, n: s.n, computedAt: new Date() },
    });
    written++;
  }
  log(`[institutional-agg] base rates: ${written} (pattern,horizon) rows over ${entries.length} cohort entries`);
  return { patterns: written };
}

/** Load the SP500 benchmark's split-adjusted close series (ascending). */
async function loadBenchmark(): Promise<PricePoint[] | null> {
  const bm = await prisma.benchmark.findUnique({ where: { code: BENCHMARK as never }, select: { id: true } });
  if (!bm) return null;
  const rows = await prisma.benchmarkPriceHistory.findMany({
    where: { benchmarkId: bm.id },
    select: { tradeDate: true, adjClose: true },
    orderBy: { tradeDate: "asc" },
  });
  const out: PricePoint[] = [];
  for (const r of rows) {
    const px = Number(r.adjClose);
    if (Number.isFinite(px) && px > 0) out.push({ t: r.tradeDate.getTime(), px });
  }
  return out.length ? out : null;
}

/**
 * Part 3e calibration: for each long_hold_mult θ in [1.0..3.0] step 0.25,
 * reconstruct the Core Holdings board per quarter (from the persisted tenure
 * columns) and emit its members as a cohort tagged `calib:long_hold_mult=θ`.
 */
async function buildCalibrationEntries(log: (m: string) => void): Promise<CohortEntry[]> {
  const rows = await prisma.$queryRaw<
    Array<{ fundId: string; period: Date; ticker: string; pct: number | null; tenure: number | null; censored: boolean | null; elite: boolean; category: string }>
  >(Prisma.sql`
    SELECT h."fundId" AS "fundId", h."filingPeriod" AS period, h.ticker, h."pctOfBook" AS pct,
           h."tenureQuarters" AS tenure, h."tenureCensored" AS censored,
           f."isMostRespected" AS elite, f.category AS category
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isActive" = true AND f."tier" = 'signal'
    WHERE h.shares > 0 AND h."tenureQuarters" IS NOT NULL`);
  if (rows.length === 0) return [];

  // fund median tenure per (fund, period) from the persisted tenures.
  const fundBook = new Map<string, TenurePoint[]>(); // `${fundId}|${period}`
  for (const r of rows) {
    const p = iso(r.period);
    const key = `${r.fundId}|${p}`;
    (fundBook.get(key) ?? fundBook.set(key, []).get(key)!).push({ tenure: r.tenure ?? 0, censored: r.censored ?? false });
  }
  const fundMedian = new Map<string, number>();
  for (const [key, book] of fundBook) fundMedian.set(key, fundMedianTenure(book, CFG).median);

  // voters per (ticker, period)
  const votersByTP = new Map<string, Voter[]>();
  for (const r of rows) {
    const p = iso(r.period);
    const median = fundMedian.get(`${r.fundId}|${p}`) ?? 0;
    const v: Voter = {
      fundId: r.fundId,
      tenure: r.tenure ?? 0,
      censored: r.censored ?? false,
      tenureMult: tenureMult(r.tenure ?? 0, median),
      weightBps: (r.pct ?? 0) * 100,
      isElite: r.elite,
      category: r.category,
    };
    const key = `${r.ticker}|${p}`;
    (votersByTP.get(key) ?? votersByTP.set(key, []).get(key)!).push(v);
  }

  const thresholds: number[] = [];
  for (let t = 1.0; t <= 3.0001; t += 0.25) thresholds.push(Math.round(t * 100) / 100);

  const out: CohortEntry[] = [];
  for (const theta of thresholds) {
    const cfg = { ...CFG, long_hold_mult: theta };
    // board per period: valid names, top core_board_size by endorsement.
    const byPeriod = new Map<string, Array<{ ticker: string; score: number }>>();
    for (const [key, holders] of votersByTP) {
      const [ticker, period] = key.split("|");
      const r = scoreEndorsement(holders, cfg);
      if (!r.valid) continue;
      (byPeriod.get(period!) ?? byPeriod.set(period!, []).get(period!)!).push({ ticker: ticker!, score: r.endorsementScore });
    }
    for (const [period, names] of byPeriod) {
      names.sort((a, b) => b.score - a.score);
      for (const n of names.slice(0, cfg.core_board_size)) {
        out.push({ pattern: `calib:long_hold_mult=${theta.toFixed(2)}`, ticker: n.ticker, entryMs: availabilityMs(period) });
      }
    }
  }
  log(`[institutional-agg] calibration sweep: ${thresholds.length} thresholds, ${out.length} board-member entries`);
  return out;
}
