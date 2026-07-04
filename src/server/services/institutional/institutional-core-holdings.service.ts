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
  isQualifiedTrimOrExit,
  scoreEndorsement,
  stasisBreakSignificance,
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

  // ── 4. Stasis-break events: a qualified trim/exit by a long-tenure holder. ──
  const stasisByTP = new Map<string, Array<{ fundId: string; tenure: number; tenureMult: number; action: "trim" | "exit" }>>();
  for (const [fundId, byTicker] of byFundTicker) {
    for (const [ticker, byPeriod] of byTicker) {
      for (let i = 1; i < periods.length; i++) {
        const prevP = periods[i - 1]!;
        const curP = periods[i]!;
        const prev = byPeriod.get(prevP);
        if (!prev) continue; // wasn't held last quarter
        const prevTp = tenureByKey.get(`${fundId}|${ticker}|${prevP}`)!;
        const prevMedian = fundMedianAt.get(`${fundId}|${prevP}`) ?? 0;
        const prevMult = tenureMult(prevTp.tenure, prevMedian);
        if (prevMult < CFG.long_hold_mult) continue; // not a long-tenure holder
        const cur = byPeriod.get(curP);
        const exited = !cur;
        if (isQualifiedTrimOrExit(prev.shares, cur?.shares ?? 0, exited, CFG)) {
          const key = `${ticker}|${curP}`;
          (stasisByTP.get(key) ?? stasisByTP.set(key, []).get(key)!).push({
            fundId,
            tenure: prevTp.tenure,
            tenureMult: prevMult,
            action: exited ? "exit" : "trim",
          });
        }
      }
    }
  }
  const stasisEventRows: Prisma.InstitutionalEventCreateManyInput[] = [];
  for (const [key, departing] of stasisByTP) {
    const [ticker, period] = key.split("|");
    const top = departing.reduce((a, b) => (b.tenureMult > a.tenureMult ? b : a));
    stasisEventRows.push({
      kind: "stasis_break",
      ticker: ticker!,
      filingPeriod: dateOf(period!),
      significance: stasisBreakSignificance(top.tenureMult, CFG),
      payload: {
        departing: departing.map((d) => ({ fundId: d.fundId, tenure: d.tenure, tenureMult: d.tenureMult, action: d.action })),
        // raw quarters for copy ("first change in N quarters") = deepest departing tenure.
        rawQuarters: top.tenure,
        deepestTenureMult: top.tenureMult,
      } as Prisma.InputJsonValue,
    });
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
