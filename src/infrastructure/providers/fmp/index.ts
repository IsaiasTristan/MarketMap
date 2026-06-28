/** FMP provider package — public surface for the Engine 1 ingestion layer. */
export * from "./types";
export {
  FmpAuthError,
  FmpRequestError,
  fmpGetJson,
  fmpGetCsv,
  fmpPool,
  num,
  str,
  isoDate,
} from "./fmp-client";
export { fetchAnalystEstimates } from "./estimates";
export { fetchGradeEvents, fetchGradesHistorical, fetchGradesConsensus } from "./grades";
export {
  fetchPriceTargetNews,
  fetchPriceTargetConsensus,
  fetchPriceTargetSummary,
} from "./price-targets";
export { fetchEarningsCalendar } from "./earnings-calendar";
export type { EarningsCalendarEntry } from "./earnings-calendar";
export { fetchScreener, screenerToReference, fetchProfile } from "./screener";
export type { ScreenerFilter } from "./screener";
export {
  fetchUpgradesDowngradesConsensusBulk,
  fetchPriceTargetSummaryBulk,
} from "./bulk";
export type { BulkRatingConsensusRow, BulkPriceTargetSummaryRow } from "./bulk";
export { fetchHistoricalEod } from "./prices";
export type { EodBar } from "./prices";
export {
  fetchIncomeStatement,
  fetchBalanceSheet,
  fetchCashFlow,
  fetchStatementPeriods,
} from "./statements";
export { fetchRatios, fetchKeyMetrics } from "./ratios";
export { fetchQuote } from "./quote";
