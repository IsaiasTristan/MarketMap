/**
 * valuation.service — EOD enterprise-value build + forward multiple
 * denominators for the per-stock detail popup.
 *
 * Serves the FactSet-style build: FDSO × live price = market cap, + total
 * debt − cash + preferred + minority interest = TEV, plus NTM / FY+1
 * consensus EBITDA and EPS for the trading-multiples table. The share price
 * itself is NOT served here — the client rides the live Yahoo intraday
 * price-series feed and recomputes MC / TEV / multiples on each tick; this
 * service only supplies the slow-moving components.
 *
 * Fetch cadence: once per ET trading date per ticker (in-memory cache keyed
 * `TICKER|yyyy-mm-dd`, in-flight promise dedupe). A cold miss costs ~5 FMP
 * calls; a server restart refetches, which is acceptable. Upgrade path if
 * persistence is ever wanted: a small Prisma table keyed (ticker, date).
 *
 * NTM = sum of the next 4 quarterly consensus periods (all 4 required);
 * falls back to a calendar-weighted FY1/FY2 annual blend when quarterly
 * coverage is incomplete. FY+1 = the fiscal year AFTER the current
 * unreported one (FY2 consensus), anchored on the latest reported annual
 * income statement.
 *
 * Funds/ETFs (no financial statements) degrade to kind "fund": only shares
 * (from the FMP quote) are available, so the client renders Shares × Price =
 * Market Cap and omits the capital-structure lines and multiples.
 */
import {
  fetchAnalystEstimates,
  fetchIncomeStatement,
  fetchQuote,
  fetchStatementPeriods,
} from "@/infrastructure/providers/fmp";
import type {
  NormalizedEstimatePeriod,
  NormalizedStatementPeriod,
} from "@/infrastructure/providers/fmp";

export type ValuationKind = "company" | "fund";
export type NtmBasis = "quarterly-sum" | "annual-blend";

export interface ValuationSnapshot {
  ticker: string;
  /** ET trading date the snapshot was fetched for (yyyy-mm-dd). */
  asOfDate: string;
  /** ISO timestamp of the FMP fetch. */
  fetchedAt: string;
  kind: ValuationKind;
  /** Fully diluted shares outstanding (actual share count, not millions). */
  fdso: number | null;
  fdsoSource: "income-diluted" | "quote-shares" | null;
  /** Fiscal period end the balance-sheet components come from. */
  balanceFiscalDate: string | null;
  totalDebt: number | null;
  cash: number | null;
  preferredEquity: number | null;
  minorityInterest: number | null;
  /** EOD reference price (FMP quote) — client fallback when no live tape. */
  refPrice: number | null;
  ntm: { ebitda: number | null; eps: number | null; basis: NtmBasis | null };
  fyPlus1: {
    ebitda: number | null;
    eps: number | null;
    fiscalDate: string | null;
    /** e.g. "FY Dec-27" — column header for the multiples table. */
    fiscalYearLabel: string | null;
  };
  warnings: string[];
}

/** ET calendar date (yyyy-mm-dd) — the daily cache key component. */
function etTradingDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** "2027-12-31" → "FY Dec-27". */
function fiscalYearLabel(fiscalDate: string): string | null {
  const m = fiscalDate.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return null;
  return `FY ${month}-${m[1]!.slice(2)}`;
}

function settled<T>(r: PromiseSettledResult<T>, fallback: T, warnings: string[], label: string): T {
  if (r.status === "fulfilled") return r.value;
  warnings.push(`${label} fetch failed`);
  return fallback;
}

/**
 * Share count from the FMP quote: sharesOutstanding when present, else
 * derived marketCap / price (FMP omits sharesOutstanding for many ETFs).
 */
function quoteShares(quote: { price: number | null; marketCap: number | null; sharesOutstanding: number | null } | null): number | null {
  if (!quote) return null;
  if (quote.sharesOutstanding != null && quote.sharesOutstanding > 0) return quote.sharesOutstanding;
  if (quote.marketCap != null && quote.marketCap > 0 && quote.price != null && quote.price > 0) {
    return quote.marketCap / quote.price;
  }
  return null;
}

interface NtmResult {
  ebitda: number | null;
  eps: number | null;
  basis: NtmBasis | null;
}

/**
 * NTM consensus: sum the first 4 quarterly estimate periods strictly after
 * the latest reported quarter. Both metrics must have all 4 quarters or the
 * whole computation falls back to the calendar-weighted annual blend
 * `w·FY1 + (1−w)·FY2`, `w = clamp(days(today → FY1 end)/365, 0, 1)`, so the
 * two multiples always share one basis (footnoted in the UI).
 */
function computeNtm(
  quarterly: NormalizedEstimatePeriod[],
  fy1: NormalizedEstimatePeriod | null,
  fy2: NormalizedEstimatePeriod | null,
  latestReportedQuarter: string | null,
  today: string,
  warnings: string[],
): NtmResult {
  const anchor = latestReportedQuarter ?? today;
  const forward = quarterly.filter((q) => q.fiscalDate > anchor).slice(0, 4);
  if (
    forward.length === 4 &&
    forward.every((q) => q.ebitda.avg !== null) &&
    forward.every((q) => q.eps.avg !== null)
  ) {
    return {
      ebitda: forward.reduce((s, q) => s + q.ebitda.avg!, 0),
      eps: forward.reduce((s, q) => s + q.eps.avg!, 0),
      basis: "quarterly-sum",
    };
  }

  if (!fy1) {
    if (quarterly.length > 0 || fy2) warnings.push("NTM unavailable (no forward FY1 consensus)");
    return { ebitda: null, eps: null, basis: null };
  }
  const DAY_MS = 24 * 60 * 60 * 1000;
  const days = (Date.parse(fy1.fiscalDate) - Date.parse(today)) / DAY_MS;
  const w = Math.min(1, Math.max(0, days / 365));
  const blend = (a: number | null, b: number | null): number | null => {
    if (a === null) return null;
    if (b === null) {
      // FY2 missing — approximate NTM by FY1 alone (exact when w = 1).
      if (w < 0.95) warnings.push("NTM approximated by FY1 (no FY2 consensus)");
      return a;
    }
    return w * a + (1 - w) * b;
  };
  return {
    ebitda: blend(fy1.ebitda.avg, fy2?.ebitda.avg ?? null),
    eps: blend(fy1.eps.avg, fy2?.eps.avg ?? null),
    basis: "annual-blend",
  };
}

async function buildSnapshot(ticker: string, asOfDate: string): Promise<ValuationSnapshot> {
  const warnings: string[] = [];
  const [quartersR, annualIncomeR, quarterlyEstR, annualEstR, quoteR] = await Promise.allSettled([
    fetchStatementPeriods(ticker, "quarter", 8),
    fetchIncomeStatement(ticker, "annual", 2),
    fetchAnalystEstimates(ticker, "quarter", 16),
    fetchAnalystEstimates(ticker, "annual", 8),
    fetchQuote(ticker),
  ]);

  const quarters = settled(quartersR, [] as NormalizedStatementPeriod[], warnings, "Quarterly statements");
  const annualIncome = settled(annualIncomeR, [], warnings, "Annual income statement");
  const quarterlyEst = settled(quarterlyEstR, [] as NormalizedEstimatePeriod[], warnings, "Quarterly estimates");
  const annualEst = settled(annualEstR, [] as NormalizedEstimatePeriod[], warnings, "Annual estimates");
  const quote = settled(quoteR, null, warnings, "Quote");

  const fetchedAt = new Date().toISOString();
  const kind: ValuationKind = quarters.length === 0 ? "fund" : "company";

  if (kind === "fund") {
    const shares = quoteShares(quote);
    return {
      ticker,
      asOfDate,
      fetchedAt,
      kind,
      fdso: shares,
      fdsoSource: shares != null ? "quote-shares" : null,
      balanceFiscalDate: null,
      totalDebt: null,
      cash: null,
      preferredEquity: null,
      minorityInterest: null,
      refPrice: quote?.price ?? null,
      ntm: { ebitda: null, eps: null, basis: null },
      fyPlus1: { ebitda: null, eps: null, fiscalDate: null, fiscalYearLabel: null },
      warnings,
    };
  }

  // Latest quarter (rows ascend by fiscalDate). Balance components come from
  // the most recent quarter that actually joined a balance sheet — quarterly
  // income can post a few days before the balance statement lands.
  const latestQuarter = quarters[quarters.length - 1]!;
  const latestWithBalance =
    [...quarters].reverse().find((q) => q.totalDebt !== null || q.cash !== null) ?? latestQuarter;
  if (latestWithBalance.fiscalDate !== latestQuarter.fiscalDate) {
    warnings.push(`Balance sheet as of ${latestWithBalance.fiscalDate} (older than latest income)`);
  }

  let fdso: number | null = null;
  let fdsoSource: ValuationSnapshot["fdsoSource"] = null;
  const latestDiluted = [...quarters].reverse().find((q) => q.sharesDiluted !== null);
  if (latestDiluted?.sharesDiluted != null) {
    fdso = latestDiluted.sharesDiluted;
    fdsoSource = "income-diluted";
  } else {
    fdso = quoteShares(quote);
    if (fdso != null) {
      fdsoSource = "quote-shares";
      warnings.push("Diluted share count unavailable — using basic shares from quote");
    }
  }

  // FY anchoring: latest reported ANNUAL fiscal end L → FY1 = first annual
  // estimate after L, FY2 (= the FY+1 column) the next one.
  const latestAnnualDate = annualIncome
    .map((r) => (typeof r.date === "string" ? r.date.slice(0, 10) : ""))
    .filter(Boolean)
    .sort()
    .pop() ?? null;
  const forwardAnnual = latestAnnualDate
    ? annualEst.filter((e) => e.fiscalDate > latestAnnualDate)
    : annualEst.filter((e) => e.fiscalDate > asOfDate);
  const fy1 = forwardAnnual[0] ?? null;
  const fy2 = forwardAnnual[1] ?? null;
  if (!fy2) warnings.push("No FY+1 consensus");

  const ntm = computeNtm(quarterlyEst, fy1, fy2, latestQuarter.fiscalDate, asOfDate, warnings);

  return {
    ticker,
    asOfDate,
    fetchedAt,
    kind,
    fdso,
    fdsoSource,
    balanceFiscalDate: latestWithBalance.fiscalDate,
    totalDebt: latestWithBalance.totalDebt,
    cash: latestWithBalance.cash,
    preferredEquity: latestWithBalance.preferredEquity,
    minorityInterest: latestWithBalance.minorityInterest,
    refPrice: quote?.price ?? null,
    ntm,
    fyPlus1: {
      ebitda: fy2?.ebitda.avg ?? null,
      eps: fy2?.eps.avg ?? null,
      fiscalDate: fy2?.fiscalDate ?? null,
      fiscalYearLabel: fy2 ? fiscalYearLabel(fy2.fiscalDate) : null,
    },
    warnings,
  };
}

/** One entry per ticker — replaced when the ET trading date rolls over. */
const cache = new Map<string, ValuationSnapshot>();
const inflight = new Map<string, Promise<ValuationSnapshot>>();

/** Reset the cache. Test-only. */
export function _resetValuationCache(): void {
  cache.clear();
  inflight.clear();
}

export async function getValuationSnapshot(tickerRaw: string): Promise<ValuationSnapshot> {
  const ticker = tickerRaw.trim().toUpperCase();
  const asOfDate = etTradingDate(new Date());
  const key = `${ticker}|${asOfDate}`;

  const hit = cache.get(ticker);
  if (hit && hit.asOfDate === asOfDate) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const p = buildSnapshot(ticker, asOfDate)
    .then((snap) => {
      cache.set(ticker, snap);
      return snap;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}
