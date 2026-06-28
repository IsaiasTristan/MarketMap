/**
 * Engine 2 — trap & data-quality flags. Pure, no I/O. These are DISPLAY-ONLY in
 * V1: they never modify the equal-weight composite, they just help the user see
 * why a superficially attractive score may not be investable. Each flag is
 * raised only when its input is present (null inputs never raise a flag), so a
 * data gap reads as "no flag", not a false positive.
 */

export const FLAGS = {
  HIGH_LEVERAGE: "HIGH LEVERAGE",
  NEGATIVE_FCF: "NEGATIVE FCF",
  LOW_INTEREST_COVERAGE: "LOW INTEREST COVERAGE",
  EQUITY_DILUTION: "EQUITY DILUTION",
  ESTIMATE_COVERAGE_LOW: "ESTIMATE COVERAGE LOW",
  FORECAST_DISPERSION_HIGH: "FORECAST DISPERSION HIGH",
  MOMENTUM_DETERIORATING: "MOMENTUM DETERIORATING",
  WORKING_CAPITAL_BOOST: "WORKING CAPITAL BOOST",
  ONE_QUARTER_INFLECTION: "ONE-QUARTER INFLECTION",
  STALE_DATA: "STALE DATA",
  POSSIBLE_DISTRESS: "POSSIBLE DISTRESS",
  MICROCAP: "MICROCAP",
  FINANCIAL_COMPANY: "FINANCIAL COMPANY — SPECIAL METHODOLOGY",
  INSUFFICIENT_DATA: "INSUFFICIENT DATA",
} as const;

export const FLAG_THRESHOLDS = {
  highLeverage: 4, // net debt / EBITDA
  lowInterestCoverage: 1.5, // TTM EBITDA / TTM interest
  equityDilution: 0.05, // YoY diluted-share growth
  estimateCoverageLow: 5, // analyst count
  dispersionHigh: 0.5, // EPS dispersion (high-low)/|avg|
  workingCapitalBoost: -0.5, // workingCapitalQuality component (negative = release)
  persistenceLow: 0.5, // breadth below which inflection looks one-off
  staleDays: 200, // calendar days since latest fiscal date
  microcap: 300_000_000, // market cap floor
} as const;

const FINANCIAL_SECTOR_RE = /financ|bank|insur|capital market|reit|real estate/i;

export interface FlagInputs {
  netDebtToEbitda: number | null;
  fcfTtm: number | null;
  interestCoverage: number | null; // TTM EBITDA / TTM interest (capped is fine)
  dilutedShareGrowthYoy: number | null; // raw YoY (positive = dilution)
  analystCount: number | null;
  epsDispersion: number | null;
  residual6m1m: number | null;
  workingCapitalQuality: number | null; // oriented component (negative = release)
  persistenceBreadth: number | null;
  ebitdaMarginInflection: number | null;
  ebitdaTtm: number | null;
  totalEquity: number | null;
  marketCap: number | null;
  daysSinceLatestFiscal: number | null;
  sector: string | null;
  validBoxCount: number;
}

/** Compute the set of raised flags for one ticker (display-only, sorted). */
export function computeFlags(i: FlagInputs): string[] {
  const t = FLAG_THRESHOLDS;
  const out = new Set<string>();

  if (i.netDebtToEbitda !== null && i.netDebtToEbitda > t.highLeverage) out.add(FLAGS.HIGH_LEVERAGE);
  if (i.fcfTtm !== null && i.fcfTtm < 0) out.add(FLAGS.NEGATIVE_FCF);
  if (i.interestCoverage !== null && i.interestCoverage < t.lowInterestCoverage)
    out.add(FLAGS.LOW_INTEREST_COVERAGE);
  if (i.dilutedShareGrowthYoy !== null && i.dilutedShareGrowthYoy > t.equityDilution)
    out.add(FLAGS.EQUITY_DILUTION);
  if (i.analystCount !== null && i.analystCount < t.estimateCoverageLow)
    out.add(FLAGS.ESTIMATE_COVERAGE_LOW);
  if (i.epsDispersion !== null && i.epsDispersion > t.dispersionHigh)
    out.add(FLAGS.FORECAST_DISPERSION_HIGH);
  if (i.residual6m1m !== null && i.residual6m1m < 0) out.add(FLAGS.MOMENTUM_DETERIORATING);
  if (i.workingCapitalQuality !== null && i.workingCapitalQuality < t.workingCapitalBoost)
    out.add(FLAGS.WORKING_CAPITAL_BOOST);
  if (
    i.persistenceBreadth !== null &&
    i.persistenceBreadth < t.persistenceLow &&
    i.ebitdaMarginInflection !== null &&
    i.ebitdaMarginInflection > 0
  )
    out.add(FLAGS.ONE_QUARTER_INFLECTION);
  if (i.daysSinceLatestFiscal !== null && i.daysSinceLatestFiscal > t.staleDays)
    out.add(FLAGS.STALE_DATA);
  if (
    (i.ebitdaTtm !== null && i.ebitdaTtm < 0 && i.netDebtToEbitda !== null && i.netDebtToEbitda > t.highLeverage) ||
    (i.totalEquity !== null && i.totalEquity < 0)
  )
    out.add(FLAGS.POSSIBLE_DISTRESS);
  if (i.marketCap !== null && i.marketCap < t.microcap) out.add(FLAGS.MICROCAP);
  if (i.sector !== null && FINANCIAL_SECTOR_RE.test(i.sector)) out.add(FLAGS.FINANCIAL_COMPANY);
  if (i.validBoxCount < 8) out.add(FLAGS.INSUFFICIENT_DATA);

  return [...out].sort();
}
