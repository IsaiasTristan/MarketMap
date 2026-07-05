/**
 * Engine 3 — Fresh calls feed read layer (FUNDS Part 3).
 *
 * A fresh call = a qualified initiation that is PENDING with zero follow votes so far.
 * Consumes the follow scoreboard (per-fund rate + outcomes + assembled initiations),
 * ranks via the pure rankFreshCalls core, and enriches each row with the price since
 * the ENTRY FILING DATE (not period-end), an entered-into-weakness flag, and a
 * qualifier line. The base-rate header pools top-decile originators' forward 2Q returns.
 */
import { prisma } from "@/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import { rankFreshCalls, type FreshCallRankInput } from "@/domain/calculations/fresh-calls";
import { isFreshCall } from "@/domain/calculations/fresh-calls";
import { priceAsOf, summarizeCohort, type PricePoint, type CohortSummary } from "@/domain/calculations/base-rates";
import { FUNDS_ATTRIBUTION_CONFIG, type FundsAttributionConfig } from "@/domain/calculations/funds-attribution-config";
import { getFollowScoreboard } from "./institutional-follow.service";

const DAY = 86_400_000;
const QUARTER_DAYS = 91;
const WEAKNESS_THRESHOLD = -0.1; // price fell ≥10% into the entry quarter

export interface FreshCallRow {
  fundId: string;
  cik: string;
  fundName: string;
  ticker: string;
  companyName: string | null;
  sector: string | null;
  marketCapTier: string | null;
  sizingMult: number;
  enteredPeriod: string;
  ageQuarters: number;
  pctOfBook: number | null;
  /** Adjusted-series return since the entry FILING date (fraction); null if unknown. */
  priceSinceFiling: number | null;
  enteredIntoWeakness: boolean;
  lowN: boolean;
  rankScore: number;
  originatorFollowRate: number | null;
  qualifiers: string[];
}

export interface FreshCallsPayload {
  filingPeriod: string;
  rows: FreshCallRow[];
  /** Base-rate header: fwd 2Q of historical calls by top-decile originators. */
  baseRate: CohortSummary;
}

export async function getFreshCalls(
  config: FundsAttributionConfig = FUNDS_ATTRIBUTION_CONFIG,
): Promise<FreshCallsPayload | null> {
  const sb = await getFollowScoreboard(config);
  if (!sb) return null;
  const emptyBase: CohortSummary = { excessReturn: null, hitRate: null, n: 0, sufficient: false };
  if (sb.rows.length === 0) return { filingPeriod: sb.filingPeriod, rows: [], baseRate: emptyBase };

  const rateByFund = new Map(sb.rows.map((r) => [r.fundId, r]));

  // Collect fresh outcomes (pending + zero followers) across funds. A fund can
  // re-initiate the same ticker in more than one quarter (both still fresh); keep
  // only the most recent entry per (fund, ticker) — smallest age = latest quarter.
  const inputs: FreshCallRankInput[] = [];
  for (const [fundId, outs] of sb.outcomesByFund) {
    const meta = rateByFund.get(fundId);
    const freshest = new Map<string, (typeof outs)[number]>();
    for (const o of outs) {
      if (!isFreshCall(o)) continue;
      const prev = freshest.get(o.ticker);
      if (!prev || o.age < prev.age) freshest.set(o.ticker, o);
    }
    for (const o of freshest.values()) {
      inputs.push({
        fundId,
        ticker: o.ticker,
        sector: o.sector,
        strength: o.strength,
        status: o.status,
        followerFunds: o.followerFunds,
        ageQuarters: o.age,
        originatorFollowRate: meta?.followRate ?? null,
        originatorRateSufficient: meta?.rateSufficient ?? false,
      });
    }
  }
  const ranked = rankFreshCalls(inputs, sb.cohortMedianRate, config);
  if (ranked.length === 0) return { filingPeriod: sb.filingPeriod, rows: [], baseRate: await topDecileBaseRate(sb, config) };

  // A fresh call's entry quarter index = (latest − age); map back to a period string.
  const enteredPeriodOf = (ageQuarters: number): string => sb.periods[sb.periods.length - 1 - ageQuarters]!;

  const holdingRows = await prisma.$queryRaw<
    Array<{ fundId: string; ticker: string; period: Date; pct: number | null; filingDate: Date | null; name: string | null }>
  >(Prisma.sql`
    SELECT h."fundId" AS "fundId", h.ticker, h."filingPeriod" AS period, h."pctOfBook" AS pct,
           h."filingDate" AS "filingDate", h."nameOfIssuer" AS name
    FROM "FundHoldingSnapshot" h
    WHERE h."initiationStrength" IS NOT NULL AND h.shares > 0`);
  const holdingByKey = new Map<string, { pct: number | null; filingDate: Date | null; name: string | null }>();
  for (const h of holdingRows) holdingByKey.set(`${h.fundId}|${h.ticker}|${h.period.toISOString().slice(0, 10)}`, { pct: h.pct, filingDate: h.filingDate, name: h.name });

  // Name metadata (company name, sector, cap tier) at the latest period.
  const tickers = [...new Set(ranked.map((r) => r.ticker))];
  const nameMeta = await prisma.institutionalNameAggregate.findMany({
    where: { ticker: { in: tickers }, filingPeriod: new Date(`${sb.filingPeriod}T00:00:00.000Z`) },
    select: { ticker: true, companyName: true, sector: true, marketCapTier: true },
  });
  const nameByTicker = new Map(nameMeta.map((m) => [m.ticker, m]));

  // Price series for the fresh tickers (chunked).
  const priceByTicker = await loadPriceSeries(tickers);

  const rows: FreshCallRow[] = ranked.map((r): FreshCallRow => {
    const enteredPeriod = enteredPeriodOf(r.ageQuarters);
    const hk = holdingByKey.get(`${r.fundId}|${r.ticker}|${enteredPeriod}`);
    const meta = rateByFund.get(r.fundId);
    const nm = nameByTicker.get(r.ticker);
    const series = priceByTicker.get(r.ticker);
    const periodEndMs = new Date(`${enteredPeriod}T00:00:00.000Z`).getTime();
    const filingMs = hk?.filingDate ? hk.filingDate.getTime() : periodEndMs + 46 * DAY;

    let priceSinceFiling: number | null = null;
    let enteredIntoWeakness = false;
    if (series && series.length) {
      const base = priceAsOf(series, filingMs);
      const latest = series[series.length - 1]!.px;
      if (base != null && base > 0) priceSinceFiling = Math.round((latest / base - 1) * 1e4) / 1e4;
      const qStart = priceAsOf(series, periodEndMs - QUARTER_DAYS * DAY);
      const atEntry = priceAsOf(series, periodEndMs);
      if (qStart != null && qStart > 0 && atEntry != null) enteredIntoWeakness = atEntry / qStart - 1 <= WEAKNESS_THRESHOLD;
    }

    const qualifiers: string[] = [];
    if (r.lowN) qualifiers.push("low-n originator — weight accordingly");
    else if (meta?.followRate != null) qualifiers.push(`${Math.round(meta.followRate * 100)}% follow originator`);
    if (r.sector && meta?.bestSector && r.sector === meta.bestSector && meta.bestSectorRate != null)
      qualifiers.push(`${r.sector} is their best sector (${Math.round(meta.bestSectorRate * 100)}%)`);
    if (enteredIntoWeakness) qualifiers.push("entered into weakness (−10%+ into entry qtr)");
    if (r.ageQuarters >= 2) qualifiers.push(`${r.ageQuarters === 2 ? "2nd" : `${r.ageQuarters + 1}th`} qtr unfollowed`);

    return {
      fundId: r.fundId,
      cik: meta?.cik ?? "",
      fundName: meta?.name ?? "",
      ticker: r.ticker,
      companyName: nm?.companyName ?? hk?.name ?? null,
      sector: nm?.sector ?? r.sector,
      marketCapTier: nm?.marketCapTier ?? null,
      sizingMult: r.strength,
      enteredPeriod,
      ageQuarters: r.ageQuarters,
      pctOfBook: hk?.pct ?? null,
      priceSinceFiling,
      enteredIntoWeakness,
      lowN: r.lowN,
      rankScore: r.rankScore,
      originatorFollowRate: r.originatorFollowRate,
      qualifiers,
    };
  });

  return { filingPeriod: sb.filingPeriod, rows, baseRate: await topDecileBaseRate(sb, config) };
}

/** Base-rate header: pool fwd-2Q of qualified initiations by top-decile originators. */
async function topDecileBaseRate(
  sb: Awaited<ReturnType<typeof getFollowScoreboard>>,
  _config: FundsAttributionConfig,
): Promise<CohortSummary> {
  if (!sb) return { excessReturn: null, hitRate: null, n: 0, sufficient: false };
  const rated = sb.rows.filter((r) => r.rateSufficient && r.followRate != null).sort((a, b) => b.followRate! - a.followRate!);
  if (rated.length === 0) return { excessReturn: null, hitRate: null, n: 0, sufficient: false };
  const cut = Math.max(1, Math.ceil(rated.length * 0.1));
  const topFunds = new Set(rated.slice(0, cut).map((r) => r.fundId));
  const fwd2 = sb.initiations.filter((i) => topFunds.has(i.fundId) && i.fwd2q != null && Number.isFinite(i.fwd2q!)).map((i) => i.fwd2q!);
  return summarizeCohort(fwd2); // minN 30 → "insufficient history" below that
}

async function loadPriceSeries(tickers: string[]): Promise<Map<string, PricePoint[]>> {
  const out = new Map<string, PricePoint[]>();
  const secs = await prisma.security.findMany({ where: { ticker: { in: tickers } }, select: { id: true, ticker: true } });
  if (secs.length === 0) return out;
  const secIdToTicker = new Map(secs.map((s) => [s.id, s.ticker]));
  const secIds = secs.map((s) => s.id);
  // Fresh calls are recent (within the pending window), so ~2y of history covers both
  // the since-filing base and the entry-quarter weakness lookback; bounding the range
  // keeps the load off the napi overflow path.
  const fromDate = new Date(Date.now() - 730 * DAY);
  const CHUNK = 120;
  for (let i = 0; i < secIds.length; i += CHUNK) {
    const batch = secIds.slice(i, i + CHUNK);
    const prices = await prisma.priceHistory.findMany({
      where: { securityId: { in: batch }, tradeDate: { gte: fromDate } },
      select: { securityId: true, tradeDate: true, adjClose: true },
      orderBy: { tradeDate: "asc" },
    });
    for (const p of prices) {
      const px = Number(p.adjClose);
      if (!Number.isFinite(px) || px <= 0) continue;
      const t = secIdToTicker.get(p.securityId)!;
      (out.get(t) ?? out.set(t, []).get(t)!).push({ t: p.tradeDate.getTime(), px });
    }
  }
  return out;
}
