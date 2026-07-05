/**
 * Engine 3 — Fund returns precompute (Fund Overview Part 1). The thin DB seam over
 * the pure cores in domain/calculations/fund-returns.ts + return-series.ts.
 *
 * Per (fund, quarter) it computes the ESTIMATED long-book return the fund's reported
 * book EARNED reaching that quarter-end (book frozen at the PRIOR filing, value-
 * weighted with ADJUSTED-price returns over the quarter), and the CLONE return of the
 * same book entered at the PRIOR filing DATE and held to this filing date (what a
 * copier could actually achieve). It then chains the clone series to an annualized
 * clone alpha vs the benchmark (SPY total return) and derives fund_quality_weight.
 *
 * Standing protocol: weights from reported values (levels), returns from adjClose
 * (adjusted) — never mixed. Entry timing is lookahead-free (period-end uses the last
 * close on/before; filing-date uses the first close on/after). Best-effort: a missing
 * benchmark or price history must not fail the whole aggregate. Idempotent full
 * wipe+rewrite over the fund's history, so a restated quarter re-chains automatically.
 */
import { prisma } from "@/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import { priceAsOf, type PricePoint } from "@/domain/calculations/base-rates";
import {
  quarterReturn,
  returnConfidence,
  isLowCoverage,
  fundQualityWeight,
  type BookReturnPosition,
} from "@/domain/calculations/fund-returns";
import { cloneAlpha, priceAsOfOnOrBefore } from "@/domain/calculations/return-series";
import { FUND_OVERVIEW_CONFIG, type FundOverviewConfig } from "@/domain/calculations/fund-overview-config";
import { bumpIngredientsVersion } from "./institutional-ingredients.service";

const iso = (d: Date | string): string => (typeof d === "string" ? d : d.toISOString()).slice(0, 10);
const DAY = 86_400_000;
/** 13F settlement/availability lag past period-end when a filing date is missing. */
const AVAIL_LAG_DAYS = 46;
/** How many top and bottom contributions to persist per quarter (the strip shows ~5). */
const CONTRIB_KEEP = 12;
const SEC_CHUNK = 120;

interface HoldRow {
  fundId: string;
  cik: string;
  period: string;
  ticker: string;
  value: number;
  filingDate: Date | null;
}

/** Normalize turnover to %/q (some rows store a fraction, some a percent). */
function turnoverPct(t: number | null | undefined): number | null {
  if (t == null || !Number.isFinite(t)) return null;
  return t <= 1 ? t * 100 : t;
}

export async function runReturnsPrecompute(
  log: (m: string) => void,
  cfg: FundOverviewConfig = FUND_OVERVIEW_CONFIG,
): Promise<{ funds: number; rows: number }> {
  // ── Load the long-equity book of every active fund across all periods. ──
  const rows = await prisma.$queryRaw<HoldRow[]>(Prisma.sql`
    SELECT h."fundId" AS "fundId", h.cik, h."filingPeriod" AS period, h.ticker,
           h.value::float8 AS value, h."filingDate" AS "filingDate"
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isActive" = true
    WHERE h.shares > 0 AND h.value > 0`);
  if (rows.length === 0) {
    log("[institutional-agg] returns: no holdings");
    return { funds: 0, rows: 0 };
  }

  // fund → period → positions[]; and per (fund,period) the filing date.
  const byFund = new Map<string, Map<string, HoldRow[]>>();
  const filingDateAt = new Map<string, number>(); // `${fundId}|${period}` → filing ms
  const cikByFund = new Map<string, string>();
  for (const r of rows) {
    r.period = iso(r.period as unknown as Date);
    cikByFund.set(r.fundId, r.cik);
    let byPeriod = byFund.get(r.fundId);
    if (!byPeriod) byFund.set(r.fundId, (byPeriod = new Map()));
    (byPeriod.get(r.period) ?? byPeriod.set(r.period, []).get(r.period)!).push(r);
    if (r.filingDate) {
      const key = `${r.fundId}|${r.period}`;
      const ms = r.filingDate.getTime();
      if (!filingDateAt.has(key) || ms < filingDateAt.get(key)!) filingDateAt.set(key, ms);
    }
  }

  // ── Price series for every held ticker + the benchmark (batch, chunked). ──
  const tickers = [...new Set(rows.map((r) => r.ticker))];
  const secs = await prisma.security.findMany({ where: { ticker: { in: tickers } }, select: { id: true, ticker: true } });
  const secIdByTicker = new Map(secs.map((s) => [s.ticker, s.id]));
  const priceBySec = new Map<string, PricePoint[]>();
  const secIds = secs.map((s) => s.id);
  for (let i = 0; i < secIds.length; i += SEC_CHUNK) {
    const batch = secIds.slice(i, i + SEC_CHUNK);
    const prices = await prisma.priceHistory.findMany({
      where: { securityId: { in: batch } },
      select: { securityId: true, tradeDate: true, adjClose: true },
      orderBy: { tradeDate: "asc" },
    });
    for (const p of prices) {
      const px = Number(p.adjClose);
      if (!Number.isFinite(px) || px <= 0) continue;
      (priceBySec.get(p.securityId) ?? priceBySec.set(p.securityId, []).get(p.securityId)!).push({ t: p.tradeDate.getTime(), px });
    }
  }
  const benchSeries = await loadBenchmarkSeries(cfg.benchmark_symbol);
  if (!benchSeries) log(`[institutional-agg] returns: benchmark ${cfg.benchmark_symbol} price series missing — excess/alpha will be null`);

  // Per-quarter turnover (for the trailing-4q confidence tag).
  const bookRows = await prisma.fundBookSnapshot.findMany({ select: { fundId: true, filingPeriod: true, turnover: true } });
  const turnoverAt = new Map<string, number>(); // `${fundId}|${period}` → %/q
  for (const b of bookRows) {
    const tp = turnoverPct(b.turnover);
    if (tp != null) turnoverAt.set(`${b.fundId}|${iso(b.filingPeriod)}`, tp);
  }

  const periodEndMs = (p: string): number => new Date(`${p}T00:00:00.000Z`).getTime();
  const filingMs = (fundId: string, p: string): number =>
    filingDateAt.get(`${fundId}|${p}`) ?? periodEndMs(p) + AVAIL_LAG_DAYS * DAY;

  /** Adjusted return of one ticker over [entryMs, exitMs], using the given as-of rule. */
  const posReturn = (
    ticker: string,
    entryMs: number,
    exitMs: number,
    onOrBefore: boolean,
  ): number | null => {
    const secId = secIdByTicker.get(ticker);
    const series = secId ? priceBySec.get(secId) : undefined;
    if (!series) return null;
    const entry = onOrBefore ? priceAsOfOnOrBefore(series, entryMs) : priceAsOf(series, entryMs);
    const exit = onOrBefore ? priceAsOfOnOrBefore(series, exitMs) : priceAsOf(series, exitMs);
    if (entry == null || exit == null) return null;
    return exit / entry - 1;
  };
  const benchReturn = (entryMs: number, exitMs: number, onOrBefore: boolean): number | null => {
    if (!benchSeries) return null;
    const entry = onOrBefore ? priceAsOfOnOrBefore(benchSeries, entryMs) : priceAsOf(benchSeries, entryMs);
    const exit = onOrBefore ? priceAsOfOnOrBefore(benchSeries, exitMs) : priceAsOf(benchSeries, exitMs);
    if (entry == null || exit == null) return null;
    return exit / entry - 1;
  };

  // ── Per fund: one row per quarter that EARNED a return (i≥1), chained clone alpha. ──
  const returnRows: Prisma.FundReturnSnapshotCreateManyInput[] = [];
  const summaries: Array<{ fundId: string; cloneAlpha: number | null; quarters: number; qualityWeight: number }> = [];

  for (const [fundId, byPeriod] of byFund) {
    const periods = [...byPeriod.keys()].sort();
    const cik = cikByFund.get(fundId)!;
    const cloneSeries: Array<number | null> = [];
    const benchCloneSeries: Array<number | null> = [];

    for (let i = 1; i < periods.length; i++) {
      const prevP = periods[i - 1]!;
      const curP = periods[i]!;
      const book = byPeriod.get(prevP)!; // the book that was HELD through this quarter
      const totalVal = book.reduce((a, p) => a + p.value, 0);
      if (!(totalVal > 0)) continue;

      const prevEndMs = periodEndMs(prevP);
      const curEndMs = periodEndMs(curP);
      const prevFilingMs = filingMs(fundId, prevP);
      const curFilingMs = filingMs(fundId, curP);

      const snapPositions: BookReturnPosition[] = book.map((p) => ({
        ticker: p.ticker,
        reportedWeight: p.value / totalVal,
        positionReturn: posReturn(p.ticker, prevEndMs, curEndMs, true),
      }));
      const clonePositions: BookReturnPosition[] = book.map((p) => ({
        ticker: p.ticker,
        reportedWeight: p.value / totalVal,
        positionReturn: posReturn(p.ticker, prevFilingMs, curFilingMs, false),
      }));

      const snap = quarterReturn(snapPositions);
      const clone = quarterReturn(clonePositions);
      const bSnap = benchReturn(prevEndMs, curEndMs, true);
      const bClone = benchReturn(prevFilingMs, curFilingMs, false);
      const turn = turnoverAt.get(`${fundId}|${curP}`) ?? null;

      cloneSeries.push(clone.ret);
      benchCloneSeries.push(bClone);

      // Persist bounded top+bottom contributions (already sorted by |contribBps|).
      const contribs = snap.contributions.slice(0, CONTRIB_KEEP * 2);

      returnRows.push({
        fundId,
        cik,
        filingPeriod: new Date(`${curP}T00:00:00.000Z`),
        snapshotReturn: snap.ret,
        cloneReturn: clone.ret,
        benchReturnSnapshot: bSnap,
        benchReturnClone: bClone,
        coveragePct: snap.coveragePct,
        excludedWeightBps: snap.excludedWeightBps,
        positionsCovered: snap.positionsCovered,
        positionsTotal: snap.positionsTotal,
        lowCoverage: isLowCoverage(snap.coveragePct, cfg),
        trailing4qTurnover: turn,
        confidence: turn != null ? returnConfidence(turn, cfg) : null,
        contributionsJson: contribs as unknown as Prisma.InputJsonValue,
        isTerminal: i === periods.length - 1,
      });
    }

    const ca = cloneAlpha(cloneSeries, benchCloneSeries);
    summaries.push({
      fundId,
      cloneAlpha: ca.alpha,
      quarters: ca.quarters,
      qualityWeight: fundQualityWeight(ca.alpha, cfg),
    });
  }

  // ── Write (idempotent full replace). ──
  await prisma.$transaction([
    prisma.fundReturnSnapshot.deleteMany({}),
    ...chunk(returnRows, 5000).map((c) => prisma.fundReturnSnapshot.createMany({ data: c })),
  ]);
  await prisma.$transaction([
    prisma.fundReturnSummary.deleteMany({}),
    ...chunk(
      summaries.map((s) => ({
        fundId: s.fundId,
        cloneAlpha: s.cloneAlpha,
        cloneAlphaQuarters: s.quarters,
        fundQualityWeight: s.qualityWeight,
        benchmark: cfg.benchmark_symbol,
      })),
      5000,
    ).map((c) => prisma.fundReturnSummary.createMany({ data: c })),
  ]);
  await bumpIngredientsVersion();

  log(`[institutional-agg] returns: ${returnRows.length} fund-quarter rows, ${summaries.length} fund summaries`);
  return { funds: summaries.length, rows: returnRows.length };
}

/** Load a Security's adjusted-close series (ascending) to use as the benchmark. */
async function loadBenchmarkSeries(ticker: string): Promise<PricePoint[] | null> {
  const sec = await prisma.security.findUnique({ where: { ticker }, select: { id: true } });
  if (!sec) return null;
  const prices = await prisma.priceHistory.findMany({
    where: { securityId: sec.id },
    select: { tradeDate: true, adjClose: true },
    orderBy: { tradeDate: "asc" },
  });
  const out: PricePoint[] = [];
  for (const p of prices) {
    const px = Number(p.adjClose);
    if (Number.isFinite(px) && px > 0) out.push({ t: p.tradeDate.getTime(), px });
  }
  return out.length ? out : null;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
