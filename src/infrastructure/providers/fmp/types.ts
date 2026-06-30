/**
 * FMP (Financial Modeling Prep) raw response shapes + normalized rows for
 * Engine 1. Field sets were confirmed against the live API in Phase 0
 * (scripts/revision-fmp-validate.ts). Fields are treated as spotty: every
 * numeric is optional and parsed defensively at the boundary.
 */

// ─── Leg A: analyst estimates (/stable/analyst-estimates) ──────────────────

export type FmpEstimatePeriod = "annual" | "quarter";

/** Raw row from /stable/analyst-estimates. Values are absolute dollars. */
export interface FmpAnalystEstimateRaw {
  symbol: string;
  date: string; // fiscal-period end date (YYYY-MM-DD)
  revenueLow?: number;
  revenueHigh?: number;
  revenueAvg?: number;
  ebitdaLow?: number;
  ebitdaHigh?: number;
  ebitdaAvg?: number;
  ebitLow?: number;
  ebitHigh?: number;
  ebitAvg?: number;
  netIncomeLow?: number;
  netIncomeHigh?: number;
  netIncomeAvg?: number;
  sgaExpenseLow?: number;
  sgaExpenseHigh?: number;
  sgaExpenseAvg?: number;
  epsLow?: number;
  epsHigh?: number;
  epsAvg?: number;
  numAnalystsRevenue?: number;
  numAnalystsEps?: number;
}

/** One {low, avg, high} estimate triple for a single metric. */
export interface EstimateTriple {
  low: number | null;
  avg: number | null;
  high: number | null;
}

/** Normalized estimate row for one fiscal period (one metric family each). */
export interface NormalizedEstimatePeriod {
  fiscalDate: string;
  revenue: EstimateTriple;
  ebitda: EstimateTriple;
  ebit: EstimateTriple;
  netIncome: EstimateTriple;
  sga: EstimateTriple;
  eps: EstimateTriple;
  numAnalystsRevenue: number | null;
  numAnalystsEps: number | null;
}

// ─── Leg B: grades (event-level + historical distribution + consensus) ─────

/** Raw row from /stable/grades — event-level rating change. */
export interface FmpGradeEventRaw {
  symbol: string;
  date: string;
  gradingCompany?: string;
  previousGrade?: string;
  newGrade?: string;
  action?: string;
}

export interface NormalizedRatingEvent {
  ticker: string;
  eventDate: string;
  gradingCompany: string | null;
  previousGrade: string | null;
  newGrade: string | null;
  action: string | null;
}

/** Raw row from /stable/grades-historical — monthly consensus distribution. */
export interface FmpGradesHistoricalRaw {
  symbol: string;
  date: string;
  analystRatingsStrongBuy?: number;
  analystRatingsBuy?: number;
  analystRatingsHold?: number;
  analystRatingsSell?: number;
  analystRatingsStrongSell?: number;
}

/** Raw row from /stable/grades-consensus — current distribution. */
export interface FmpGradesConsensusRaw {
  symbol: string;
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
  consensus?: string;
}

export interface RatingDistribution {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  consensus: string | null;
}

// ─── Leg B: price targets ──────────────────────────────────────────────────

/** Raw row from /stable/price-target-news — event-level target. */
export interface FmpPriceTargetNewsRaw {
  symbol: string;
  publishedDate: string; // ISO timestamp
  analystName?: string;
  analystCompany?: string;
  priceTarget?: number;
  adjPriceTarget?: number;
  priceWhenPosted?: number;
  newsPublisher?: string;
}

export interface NormalizedPriceTargetEvent {
  ticker: string;
  publishedDate: string;
  analystCompany: string | null;
  analystName: string | null;
  priceTarget: number | null;
  priceWhenPosted: number | null;
  newsPublisher: string | null;
}

/** Raw row from /stable/price-target-consensus. */
export interface FmpPriceTargetConsensusRaw {
  symbol: string;
  targetHigh?: number;
  targetLow?: number;
  targetConsensus?: number;
  targetMedian?: number;
}

export interface PriceTargetConsensus {
  high: number | null;
  low: number | null;
  consensus: number | null;
  median: number | null;
}

/** Raw row from /stable/price-target-summary. */
export interface FmpPriceTargetSummaryRaw {
  symbol: string;
  lastMonthCount?: number;
  lastMonthAvgPriceTarget?: number;
  lastQuarterCount?: number;
  lastQuarterAvgPriceTarget?: number;
  lastYearCount?: number;
  lastYearAvgPriceTarget?: number;
  allTimeCount?: number;
  allTimeAvgPriceTarget?: number;
  publishers?: string;
}

// ─── Earnings calendar ─────────────────────────────────────────────────────

export interface FmpEarningsCalendarRaw {
  symbol: string;
  date: string;
  epsActual?: number | null;
  epsEstimated?: number | null;
  revenueActual?: number | null;
  revenueEstimated?: number | null;
  lastUpdated?: string;
}

/** Raw row from /stable/earnings (per-symbol reported actuals vs consensus). */
export interface FmpEarningsRaw {
  symbol: string;
  date: string; // announcement date
  epsActual?: number | null;
  epsEstimated?: number | null;
  revenueActual?: number | null;
  revenueEstimated?: number | null;
}

/** Normalized per-report earnings actuals + pre-report consensus. */
export interface NormalizedEarnings {
  ticker: string;
  reportDate: string;
  epsActual: number | null;
  epsEstimated: number | null;
  revenueActual: number | null;
  revenueEstimated: number | null;
}

// ─── Screener + profile (universe + reference) ─────────────────────────────

export interface FmpScreenerRaw {
  symbol: string;
  companyName?: string;
  marketCap?: number;
  sector?: string;
  industry?: string;
  beta?: number;
  price?: number;
  volume?: number;
  exchange?: string;
  exchangeShortName?: string;
  country?: string;
  isEtf?: boolean;
  isFund?: boolean;
  isActivelyTrading?: boolean;
}

export interface FmpProfileRaw {
  symbol: string;
  companyName?: string;
  cik?: string;
  isin?: string;
  cusip?: string;
  sector?: string;
  industry?: string;
  exchange?: string;
  exchangeFullName?: string;
  country?: string;
  currency?: string;
  marketCap?: number;
  isActivelyTrading?: boolean;
  isEtf?: boolean;
  isFund?: boolean;
  isAdr?: boolean;
}

export interface NormalizedReference {
  ticker: string;
  companyName: string;
  cik: string | null;
  sector: string | null;
  subsector: string | null; // FMP industry
  exchange: string | null;
  country: string | null;
  currency: string | null;
  marketCap: number | null;
  identifiers: { isin?: string; cusip?: string };
}

// ═══════════════════════════════════════════════════════════════════════════
// Engine 2 — fundamentals (standardized statements + ratios/key-metrics)
//
// FMP serves standardized income-statement / balance-sheet / cash-flow rows
// (EDGAR-sourced) plus pre-computed ratios and key-metrics in a consistent
// schema. Field names vary across endpoint versions, so every numeric is
// optional and parsed defensively at the boundary; the normalize layer here is
// the ONLY place that knows FMP's field names (signal code never does).
// ═══════════════════════════════════════════════════════════════════════════

/** Raw row from /stable/income-statement. */
export interface FmpIncomeStatementRaw {
  symbol: string;
  date: string; // fiscal-period end (YYYY-MM-DD)
  fiscalYear?: string | number;
  period?: string; // FY | Q1 | Q2 | Q3 | Q4
  reportedCurrency?: string;
  revenue?: number;
  costOfRevenue?: number;
  grossProfit?: number;
  operatingExpenses?: number;
  operatingIncome?: number;
  ebitda?: number;
  depreciationAndAmortization?: number;
  sellingGeneralAndAdministrativeExpenses?: number;
  researchAndDevelopmentExpenses?: number;
  netIncome?: number;
  eps?: number;
  epsDiluted?: number;
  weightedAverageShsOut?: number;
  weightedAverageShsOutDil?: number;
  interestExpense?: number;
  incomeBeforeTax?: number;
  incomeTaxExpense?: number;
}

/** Raw row from /stable/balance-sheet-statement. */
export interface FmpBalanceSheetRaw {
  symbol: string;
  date: string;
  period?: string;
  cashAndCashEquivalents?: number;
  shortTermInvestments?: number;
  cashAndShortTermInvestments?: number;
  totalCurrentAssets?: number;
  totalAssets?: number;
  totalCurrentLiabilities?: number;
  totalDebt?: number;
  shortTermDebt?: number;
  longTermDebt?: number;
  netDebt?: number;
  totalStockholdersEquity?: number;
  totalEquity?: number;
  preferredStock?: number;
  minorityInterest?: number;
  inventory?: number;
}

/** Raw row from /stable/cash-flow-statement. */
export interface FmpCashFlowRaw {
  symbol: string;
  date: string;
  period?: string;
  netIncome?: number;
  depreciationAndAmortization?: number;
  stockBasedCompensation?: number;
  changeInWorkingCapital?: number;
  operatingCashFlow?: number;
  netCashProvidedByOperatingActivities?: number;
  capitalExpenditure?: number;
  freeCashFlow?: number;
  commonStockIssuance?: number;
  commonStockRepurchased?: number;
  netCommonStockIssuance?: number;
}

/** Normalized, merged fiscal-period statement facts (one row per fiscal date). */
export interface NormalizedStatementPeriod {
  fiscalDate: string;
  period: string | null; // FY | Q1..Q4
  fiscalYear: number | null;
  reportedCurrency: string | null;
  // income statement
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  depreciationAndAmortization: number | null;
  sga: number | null;
  rnd: number | null;
  ebitdaReported: number | null;
  sharesDiluted: number | null;
  // balance sheet
  totalDebt: number | null;
  cash: number | null;
  totalAssets: number | null;
  totalEquity: number | null;
  preferredEquity: number | null;
  minorityInterest: number | null;
  netDebtReported: number | null;
  interestExpense: number | null;
  // cash flow (OCF and capex needed for FCF + the accruals trap-detector)
  operatingCashFlow: number | null;
  capitalExpenditure: number | null;
  freeCashFlowReported: number | null;
  stockBasedCompensation: number | null;
  changeInWorkingCapital: number | null;
  commonStockIssued: number | null; // FMP commonStockIssuance (>= 0)
  commonStockRepurchased: number | null; // FMP commonStockRepurchased (<= 0)
}

/** Raw row from /stable/ratios. */
export interface FmpRatiosRaw {
  symbol: string;
  date: string;
  period?: string;
  grossProfitMargin?: number;
  ebitdaMargin?: number;
  operatingProfitMargin?: number;
  netProfitMargin?: number;
  returnOnEquity?: number;
  returnOnInvestedCapital?: number;
  returnOnCapitalEmployed?: number;
  priceToEarningsRatio?: number;
  priceToSalesRatio?: number;
  enterpriseValueMultiple?: number; // EV / EBITDA
  evToEBITDA?: number;
  debtToEquityRatio?: number;
  netDebtToEBITDA?: number;
  dividendYield?: number;
  interestCoverageRatio?: number;
  priceToFreeCashFlowRatio?: number;
}

/** Raw row from /stable/key-metrics. */
export interface FmpKeyMetricsRaw {
  symbol: string;
  date: string;
  period?: string;
  marketCap?: number;
  enterpriseValue?: number;
  evToSales?: number;
  evToEBITDA?: number;
  enterpriseValueOverEBITDA?: number;
  returnOnInvestedCapital?: number;
  freeCashFlowYield?: number;
  netDebtToEBITDA?: number;
}

/** Normalized FMP-precomputed ratios for one fiscal period (verify-before-trust). */
export interface NormalizedRatios {
  fiscalDate: string;
  grossMargin: number | null;
  ebitdaMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  roe: number | null;
  roic: number | null;
  peRatio: number | null;
  priceToSales: number | null;
  evToEbitda: number | null;
  debtToEquity: number | null;
  netDebtToEbitda: number | null;
  dividendYield: number | null;
  interestCoverage: number | null;
}

/** Normalized FMP key-metrics for one fiscal period. */
export interface NormalizedKeyMetrics {
  fiscalDate: string;
  marketCap: number | null;
  enterpriseValue: number | null;
  evToEbitda: number | null;
  evToSales: number | null;
  roic: number | null;
  fcfYield: number | null;
  netDebtToEbitda: number | null;
}

/** Raw row from /stable/quote. */
export interface FmpQuoteRaw {
  symbol: string;
  price?: number;
  marketCap?: number;
  sharesOutstanding?: number;
}

export interface NormalizedQuote {
  ticker: string;
  price: number | null;
  marketCap: number | null;
  sharesOutstanding: number | null;
}

// ─── Stock news (/stable/news/stock) ───────────────────────────────────────

/** Raw row from /stable/news/stock — one article tagged to a single symbol. */
export interface FmpStockNewsRaw {
  symbol?: string;
  publishedDate?: string; // ISO timestamp
  publisher?: string;
  title?: string;
  image?: string;
  site?: string;
  text?: string; // article snippet / preview
  url?: string;
}

/** Raw row from /stable/news/press-releases - same shape as stock news. */
export type FmpPressReleaseRaw = FmpStockNewsRaw;

/** Normalized news article tagged to one ticker. */
export interface NormalizedStockNews {
  ticker: string;
  publishedDate: string;
  title: string;
  text: string | null;
  url: string;
  site: string | null;
  publisher: string | null;
}
