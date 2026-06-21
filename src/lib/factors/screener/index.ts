/**
 * Screener pipeline — public surface.
 *
 * Pipeline steps run in this order; downstream consumers MUST respect it
 * (e.g. cohorts always built from the SURVIVING rows, never the raw set):
 *
 *   1. applyRowFilters(rows, filters)
 *   2. assignCohorts(survivingRows, refGroup)
 *   3. buildCohortStats({ rows, keyByTicker, factorColumns, summaryColumns, metric, filters })
 *   4. computeZ / computePctRank / computePctFraction
 *   5. makeRowComparator (NaN-to-bottom, ticker tiebreak)
 *
 * The sig gate is a CELL mask, not a row predicate — `sigGatePassed` is
 * called inside `buildCohortStats` to exclude masked cells from cohort
 * stats, and at render time inside the grid to mask the cell visually.
 */
export * from "./types";
export {
  applyRowFilters,
  firstFailingPredicate,
  hasAnyActiveRowFilter,
} from "./predicates";
export { assignCohorts, describeCohortKey, MIN_COHORT_SIZE } from "./cohorts";
export {
  buildCohortStats,
  factorCellValue,
  summaryColumnValue,
  columnTStat,
  sigGatePassed,
  statsFor,
} from "./stats";
export {
  computeZ,
  computePctRank,
  computePctFraction,
  Z_DISPLAY_CLIP,
  MIN_SD_FOR_Z,
} from "./derived";
export {
  compareSortKeys,
  tiebreakByTicker,
  makeRowComparator,
} from "./sort";
export type { SortDirection } from "./sort";
export {
  buildHistogramBins,
  valuePositionInCohort,
  threeTickFromStats,
  histogramMode,
  MIN_HISTOGRAM_N,
  DEFAULT_HISTOGRAM_BINS,
} from "./histogram";
export type { HistogramBin, ThreeTick } from "./histogram";
export {
  aggregateBySectorFactor,
  classifySignificance,
  MIN_SECTOR_HEATMAP_N,
} from "./sector-heatmap";
export type {
  SectorFactorAggregate,
  SectorHeatmapResult,
  SectorHeatmapSignificance,
} from "./sector-heatmap";
export {
  axisDef,
  extractAxisValue,
  clipPercentileRange,
  logScaleEligible,
  formatAxisValue,
  parseFactorAxisKey,
  SCATTER_PRESETS,
} from "./scatter";
export type { ScatterAxisKey, ScatterAxisDef } from "./scatter";
