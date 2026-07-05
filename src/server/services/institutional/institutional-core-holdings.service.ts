/**
 * Engine 3 — Core Holdings precompute (Part 3).
 *
 * Runs in the quarterly job after the name aggregates. From the signal-tier
 * holding history it:
 *   1. Computes per-(fund,ticker,quarter) tenure (consecutive held quarters,
 *      left-censored at the earliest ingested quarter) and writes it onto
 *      FundHoldingSnapshot (tenureQuarters / tenureCensored).
 *   2. Per fund/quarter, the median tenure over the fund's current book, and a
 *      suspicious-full-book-reset flag (possible CIK migration → "verify").
 *   3. Per (ticker, quarter), the fund-relative long-hold endorsement
 *      (InstitutionalCoreHolding) via the pure core-holdings scorer.
 *   4. Stasis-break events (a qualified trim/exit by a long-tenure holder) into
 *      the InstitutionalEvent feed.
 *
 * The scoring math is the pure core in domain/calculations/core-holdings.ts; this
 * file is the thin DB loader/writer.
 */
import { prisma } from "@/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import {
  fundMedianTenure,
  isLongHoldVote,
  isNameStasisBreak,
  isQualifiedTrimOrExit,
  longHoldDepartureIntensity,
  nameStasisSignificance,
  scoreEndorsement,
  stasisSeverity,
  tenureMult,
  tenureSeries,
  type TenurePoint,
  type Voter,
  CORE_HOLDINGS_CONFIG as CFG,
} from "@/domain/calculations/core-holdings";
import { signalFundFilter } from "./institutional-aggregate.service";

const iso = (d: Date | string): string => (typeof d === "string" ? d : d.toISOString()).slice(0, 10);
const dateOf = (p: string): Date => new Date(`${p}T00:00:00.000Z`);

interface HoldRow {
  fundId: string;
  period: string;
  ticker: string;
  shares: number;
  pct: number | null;
  elite: boolean;
  category: string;
}

export async function runCoreHoldingsPrecompute(log: (m: string) => void): Promise<{ coreRows: number; stasisEvents: number }> {
  const periodRows = await prisma.$queryRaw<Array<{ p: Date }>>(Prisma.sql`
    SELECT DISTINCT "filingPeriod" AS p FROM "FundHoldingSnapshot" ORDER BY p ASC`);
  const periods = periodRows.map((r) => iso(r.p));
  const periodIdx = new Map(periods.map((p, i) => [p, i]));

  const rows = await prisma.$queryRaw<HoldRow[]>(Prisma.sql`
    SELECT h."fundId" AS "fundId", h."filingPeriod" AS period, h.ticker,
           h.shares::float8 AS shares, h."pctOfBook" AS pct,
           f."isMostRespected" AS elite, f.category AS category
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isActive" = true AND f."tier" = 'signal'
    WHERE h.shares > 0`);

  // Computed clone-alpha fund_quality_weight (Fund Overview Part 1), replacing the
  // interim elite-binary weight in endorsement scoring. Populated by runReturnsPrecompute,
  // which now runs BEFORE this pass; empty map → scoreEndorsement falls back to binary.
  const qwRows = await prisma.fundReturnSummary.findMany({ select: { fundId: true, fundQualityWeight: true } });
  const qualityWeightByFund = new Map(qwRows.map((r) => [r.fundId, r.fundQualityWeight]));

  // fund → ticker → period → row
  const byFundTicker = new Map<string, Map<string, Map<string, HoldRow>>>();
  const fundMeta = new Map<string, { elite: boolean; category: string }>();
  for (const r of rows) {
    r.period = iso(r.period as unknown as Date);
    fundMeta.set(r.fundId, { elite: r.elite, category: r.category });
    let byTicker = byFundTicker.get(r.fundId);
    if (!byTicker) byFundTicker.set(r.fundId, (byTicker = new Map()));
    let byPeriod = byTicker.get(r.ticker);
    if (!byPeriod) byTicker.set(r.ticker, (byPeriod = new Map()));
    byPeriod.set(r.period, r);
  }

  // ── 1. Tenure per (fund,ticker,period). ──
  const tenureByKey = new Map<string, TenurePoint>(); // `${fundId}|${ticker}|${period}`
  const tenureUpdates: Array<{ fundId: string; ticker: string; period: string; tenure: number; censored: boolean }> = [];
  for (const [fundId, byTicker] of byFundTicker) {
    for (const [ticker, byPeriod] of byTicker) {
      const held = periods.map((p) => byPeriod.has(p));
      const series = tenureSeries(held);
      for (let i = 0; i < periods.length; i++) {
        if (!held[i]) continue;
        const tp = series[i]!;
        tenureByKey.set(`${fundId}|${ticker}|${periods[i]}`, tp);
        tenureUpdates.push({ fundId, ticker, period: periods[i]!, tenure: tp.tenure, censored: tp.censored });
      }
    }
  }

  // ── 2. Per fund/period: book, median tenure, suspicious reset. ──
  // fund → period → tickers held (for reset detection) and tenure book.
  const fundBook = new Map<string, Map<string, TenurePoint[]>>(); // fundId → period → book tenures
  const fundTickersAt = new Map<string, Map<string, Set<string>>>(); // fundId → period → held tickers
  for (const [fundId, byTicker] of byFundTicker) {
    const perPeriodBook = new Map<string, TenurePoint[]>();
    const perPeriodTickers = new Map<string, Set<string>>();
    for (const [ticker, byPeriod] of byTicker) {
      for (const p of byPeriod.keys()) {
        const tp = tenureByKey.get(`${fundId}|${ticker}|${p}`)!;
        (perPeriodBook.get(p) ?? perPeriodBook.set(p, []).get(p)!).push(tp);
        (perPeriodTickers.get(p) ?? perPeriodTickers.set(p, new Set()).get(p)!).add(ticker);
      }
    }
    fundBook.set(fundId, perPeriodBook);
    fundTickersAt.set(fundId, perPeriodTickers);
  }
  const fundMedianAt = new Map<string, number>(); // `${fundId}|${period}` → median tenure
  const suspiciousReset = new Set<string>(); // `${fundId}|${period}`
  for (const [fundId, perPeriodBook] of fundBook) {
    const tickersAt = fundTickersAt.get(fundId)!;
    for (const [p, book] of perPeriodBook) {
      fundMedianAt.set(`${fundId}|${p}`, fundMedianTenure(book, CFG).median);
      const i = periodIdx.get(p)!;
      if (i > 0) {
        const prior = tickersAt.get(periods[i - 1]!);
        if (prior && prior.size > 0) {
          const cur = tickersAt.get(p)!;
          let gone = 0;
          for (const t of prior) if (!cur.has(t)) gone++;
          if (gone / prior.size > CFG.suspicious_book_reset_pct) suspiciousReset.add(`${fundId}|${p}`);
        }
      }
    }
  }

  // ── 3. Per (ticker, period): endorsement from long-hold voters. ──
  // Gather voters per ticker|period.
  const votersByTP = new Map<string, Voter[]>();
  for (const [fundId, byTicker] of byFundTicker) {
    const meta = fundMeta.get(fundId)!;
    for (const [ticker, byPeriod] of byTicker) {
      for (const [p, row] of byPeriod) {
        const tp = tenureByKey.get(`${fundId}|${ticker}|${p}`)!;
        const median = fundMedianAt.get(`${fundId}|${p}`) ?? 0;
        const v: Voter = {
          fundId,
          tenure: tp.tenure,
          censored: tp.censored,
          tenureMult: tenureMult(tp.tenure, median),
          weightBps: (row.pct ?? 0) * 100,
          isElite: meta.elite,
          category: meta.category,
          qualityWeight: qualityWeightByFund.get(fundId),
        };
        const key = `${ticker}|${p}`;
        (votersByTP.get(key) ?? votersByTP.set(key, []).get(key)!).push(v);
      }
    }
  }

  // ticker → {companyName, sector} (latest known) for row display.
  const metaRows = await prisma.institutionalNameAggregate.findMany({
    distinct: ["ticker"],
    orderBy: { filingPeriod: "desc" },
    select: { ticker: true, companyName: true, sector: true },
  });
  const nameMeta = new Map(metaRows.map((r) => [r.ticker, { companyName: r.companyName, sector: r.sector }]));

  const coreRows: Prisma.InstitutionalCoreHoldingCreateManyInput[] = [];
  for (const [key, holders] of votersByTP) {
    const result = scoreEndorsement(holders, CFG);
    if (result.longHoldVoters === 0) continue; // only names with long-hold interest
    const [ticker, period] = key.split("|");
    const nm = nameMeta.get(ticker!);
    // verify: a suspicious full-book reset among the LONG-HOLD VOTERS (whose tenure
    // we are trusting), not any holder — otherwise mega-caps flag on unrelated funds.
    const verify = result.contributions.some((c) => suspiciousReset.has(`${c.fundId}|${period}`));
    coreRows.push({
      ticker: ticker!,
      filingPeriod: dateOf(period!),
      companyName: nm?.companyName ?? null,
      sector: nm?.sector ?? null,
      endorsementScore: result.endorsementScore,
      longHoldVoters: result.longHoldVoters,
      distinctCategories: result.distinctCategories,
      eliteVoters: result.eliteVoters,
      medianTenure: result.medianTenure,
      avgTenure: result.avgTenure,
      censoredPct: result.censoredPct,
      verifyData: verify,
      valid: result.valid,
      payload: { contributions: result.contributions } as Prisma.InputJsonValue,
    });
  }

  // ── 4. Stasis-break events (v3 Part 0): a NAME-level break of its long-hold base. ──
  // NOT one holder among many trimming — for a widely-held name ≥1 long holder trims
  // every quarter, which fired ~490 false positives/qtr. A break is this quarter's
  // long-hold DEPARTURE INTENSITY (fraction of the name's long-hold base that did a
  // qualified trim/exit) being anomalous vs the name's OWN trailing baseline.

  // Which funds actually FILED each period (any long-equity row) — a long holder whose
  // fund did not file this quarter is UNKNOWN, not a reducer (stasis_unknown_skip).
  const fundsFiledAt = new Map<string, Set<string>>();
  for (const r of rows) (fundsFiledAt.get(r.period) ?? fundsFiledAt.set(r.period, new Set()).get(r.period)!).add(r.fundId);

  // Long-hold voter set (tenure_mult ≥ long_hold_mult AND weight ≥ min_entry_bps) per (ticker,period).
  const longHoldAt = new Map<string, Set<string>>(); // `${ticker}|${period}` → fundIds
  for (const [key, holders] of votersByTP) {
    const set = new Set<string>();
    for (const v of holders) if (isLongHoldVote(v, CFG)) set.add(v.fundId);
    if (set.size) longHoldAt.set(key, set);
  }

  const allTickers = new Set<string>();
  for (const [, byTicker] of byFundTicker) for (const t of byTicker.keys()) allTickers.add(t);

  interface QDetail {
    intensity: number | null;
    priorLongHolders: number;
    departed: number;
    unknown: number;
    unknownFrac: number;
    departing: Array<{ fundId: string; tenure: number; tenureMult: number; action: "trim" | "exit" }>;
  }
  const stasisEventRows: Prisma.InstitutionalEventCreateManyInput[] = [];
  for (const ticker of allTickers) {
    const intensity: Array<number | null> = new Array(periods.length).fill(null);
    const detail: Array<QDetail | null> = new Array(periods.length).fill(null);
    for (let i = 1; i < periods.length; i++) {
      const prevP = periods[i - 1]!;
      const curP = periods[i]!;
      const priorVoters = longHoldAt.get(`${ticker}|${prevP}`);
      if (!priorVoters || priorVoters.size === 0) continue; // no long-hold base entering
      const filedCur = fundsFiledAt.get(curP);
      let departed = 0;
      let unknown = 0;
      let known = 0;
      const departing: QDetail["departing"] = [];
      for (const fundId of priorVoters) {
        const byPeriod = byFundTicker.get(fundId)?.get(ticker);
        const prev = byPeriod?.get(prevP);
        if (!prev) continue;
        const filed = filedCur?.has(fundId) ?? false;
        if (!filed) {
          unknown++;
          if (CFG.stasis_unknown_skip) continue; // UNKNOWN quarter, not a reducer
        }
        known++;
        const cur = byPeriod?.get(curP);
        const exited = !cur;
        if (isQualifiedTrimOrExit(prev.shares, cur?.shares ?? 0, exited, CFG)) {
          departed++;
          const prevTp = tenureByKey.get(`${fundId}|${ticker}|${prevP}`)!;
          const prevMedian = fundMedianAt.get(`${fundId}|${prevP}`) ?? 0;
          departing.push({ fundId, tenure: prevTp.tenure, tenureMult: tenureMult(prevTp.tenure, prevMedian), action: exited ? "exit" : "trim" });
        }
      }
      const inten = longHoldDepartureIntensity({ priorLongHolders: known, departed, unknown });
      intensity[i] = inten;
      detail[i] = { intensity: inten, priorLongHolders: known, departed, unknown, unknownFrac: priorVoters.size ? unknown / priorVoters.size : 0, departing };
    }

    for (let i = 1; i < periods.length; i++) {
      const d = detail[i];
      if (!d || d.intensity == null) continue;
      if (d.unknownFrac > CFG.stasis_unknown_max_frac) continue; // too much missing → partial, no fire
      const baseline: number[] = [];
      for (let j = Math.max(1, i - CFG.stasis_baseline_window); j < i; j++) {
        const v = intensity[j];
        if (v != null) baseline.push(v);
      }
      const sev = stasisSeverity(d.intensity, baseline, CFG);
      if (!isNameStasisBreak(d.intensity, sev.severity, d.priorLongHolders, CFG)) continue;
      const departing = [...d.departing].sort((a, b) => b.tenureMult - a.tenureMult);
      const top = departing[0];
      stasisEventRows.push({
        kind: "stasis_break",
        ticker,
        filingPeriod: dateOf(periods[i]!),
        significance: nameStasisSignificance(sev.severity!, CFG),
        payload: {
          priorLongHolders: d.priorLongHolders,
          departed: d.departed,
          unknown: d.unknown,
          intensity: d.intensity,
          severity: sev.severity,
          baselineMean: sev.mean,
          baselineSd: sev.sd,
          baselineN: sev.n,
          partialData: d.unknown > 0,
          departing: departing.map((x) => ({ fundId: x.fundId, tenure: x.tenure, tenureMult: x.tenureMult, action: x.action })),
          // deepest departing tenure — flavor for the drill copy, NOT the headline.
          rawQuarters: top?.tenure ?? 0,
          deepestTenureMult: top?.tenureMult ?? 0,
        } as Prisma.InputJsonValue,
      });
    }
  }

  // ── Write everything (idempotent). ──
  await prisma.$executeRaw`UPDATE "FundHoldingSnapshot" SET "tenureQuarters" = NULL, "tenureCensored" = NULL WHERE "tenureQuarters" IS NOT NULL`;
  const CHUNK = 5000;
  for (let i = 0; i < tenureUpdates.length; i += CHUNK) {
    const s = tenureUpdates.slice(i, i + CHUNK);
    await prisma.$executeRaw`
      UPDATE "FundHoldingSnapshot" AS h
      SET "tenureQuarters" = v.tenure, "tenureCensored" = v.censored
      FROM (
        SELECT * FROM unnest(
          ${s.map((u) => u.fundId)}::text[],
          ${s.map((u) => u.ticker)}::text[],
          ${s.map((u) => u.period)}::text[],
          ${s.map((u) => u.tenure)}::int[],
          ${s.map((u) => u.censored)}::boolean[]
        ) AS t(fund_id, ticker, period, tenure, censored)
      ) AS v
      WHERE h."fundId" = v.fund_id AND h.ticker = v.ticker AND h."filingPeriod" = v.period::date`;
  }

  // Persist per-(fund,period) median book tenure + suspicious-reset onto FundBookSnapshot
  // (already computed above as fundMedianAt/suspiciousReset — consumed by the Fund
  // Overview style vector + dossier). Idempotent per-key update.
  const tenureBook: Array<{ fundId: string; period: string; median: number; suspicious: boolean }> = [];
  for (const [key, median] of fundMedianAt) {
    const [fundId, period] = key.split("|");
    tenureBook.push({ fundId: fundId!, period: period!, median, suspicious: suspiciousReset.has(key) });
  }
  for (let i = 0; i < tenureBook.length; i += CHUNK) {
    const s = tenureBook.slice(i, i + CHUNK);
    await prisma.$executeRaw`
      UPDATE "FundBookSnapshot" AS b
      SET "medianBookTenure" = v.median, "suspiciousReset" = v.suspicious
      FROM (
        SELECT * FROM unnest(
          ${s.map((u) => u.fundId)}::text[],
          ${s.map((u) => u.period)}::text[],
          ${s.map((u) => u.median)}::float8[],
          ${s.map((u) => u.suspicious)}::boolean[]
        ) AS t(fund_id, period, median, suspicious)
      ) AS v
      WHERE b."fundId" = v.fund_id AND b."filingPeriod" = v.period::date`;
  }

  await prisma.$transaction([
    prisma.institutionalCoreHolding.deleteMany({}),
    ...chunk(coreRows, 5000).map((c) => prisma.institutionalCoreHolding.createMany({ data: c })),
  ]);
  await prisma.$transaction([
    prisma.institutionalEvent.deleteMany({ where: { kind: "stasis_break" } }),
    ...chunk(stasisEventRows, 5000).map((c) => prisma.institutionalEvent.createMany({ data: c })),
  ]);

  log(`[institutional-agg] core-holdings: ${coreRows.length} name-quarters, ${tenureUpdates.length} tenure rows, ${stasisEventRows.length} stasis breaks`);
  return { coreRows: coreRows.length, stasisEvents: stasisEventRows.length };
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
