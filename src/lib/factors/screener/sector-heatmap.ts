/**
 * Sector × factor aggregation for the universe-tilt heatmap (Phase C).
 *
 * Aggregates the screener's surviving rows by sector to produce mean β
 * (or mean return contribution / mean risk contribution depending on the
 * active metric) and a one-sample t-stat on each (sector, factor) cell.
 *
 * Locked rules (from review):
 *   • Filter-respecting: caller passes already-filtered rows. The aggregator
 *     does NOT apply row predicates itself (consistent with how cohort
 *     stats work — row filters are upstream).
 *   • Sig-gated cells excluded from the sector mean (same rule as
 *     `buildCohortStats`), so the heatmap shows what the sector
 *     *contributes* to ranking, not the unfiltered raw distribution.
 *   • Cells with fewer than `MIN_SECTOR_HEATMAP_N` contributing rows
 *     render as null (blank) — the heatmap UI distinguishes this from
 *     "low significance" via different rendering, since missing data is
 *     a different problem than a weak loading.
 *   • Significance bucketed into three discrete tiers via |t|.
 *
 * Ordering TODO (tracked but not v1): sectors currently sort alphabetical,
 * factors follow the caller-supplied (model-preset canonical) order.
 * Future improvements would order sectors by surviving-set weight and
 * factors by composite-score emphasis. Doing so requires plumbing those
 * weights through, deferred.
 */
import type { FactorCode } from "@/types/factors";
import type { PerStockRow } from "@/server/services/factor-per-stock.service";
import type { FactorGridMetric, FactorScreenerFilters } from "@/store/analysis";
import { factorCellValue, sigGatePassed } from "./stats";

/** Cells below this contributing-row threshold render blank, not low-opacity. */
export const MIN_SECTOR_HEATMAP_N = 3;

/** Discrete significance tiers; controls heatmap cell opacity. */
export type SectorHeatmapSignificance =
  | "significant"
  | "marginal"
  | "insignificant";

export interface SectorFactorAggregate {
  /** Mean of the underlying metric (β / return contrib / risk contrib). */
  mean: number;
  /** Number of contributing rows (post sig-gate, post upstream filters). */
  n: number;
  /**
   * One-sample t-stat on the mean: t = mean / (σ / √n). NaN when n < 2 or
   * σ ≤ 0 (degenerate cohort). UI treats NaN as `insignificant`.
   */
  tStat: number;
  /** Discrete significance bucket derived from |tStat|. */
  significance: SectorHeatmapSignificance;
}

export interface SectorHeatmapResult {
  /**
   * Sector → (Factor → aggregate or null). Null entries indicate the cell
   * had fewer than {@link MIN_SECTOR_HEATMAP_N} contributing rows.
   */
  bySector: Map<string, Map<FactorCode, SectorFactorAggregate | null>>;
  /** Sorted sector list (alphabetical for v1). */
  sectors: string[];
  /** Factors in the order the caller provided. */
  factors: FactorCode[];
}

/** Map |t| to the three discrete significance tiers used by the heatmap. */
export function classifySignificance(tStat: number): SectorHeatmapSignificance {
  if (!Number.isFinite(tStat)) return "insignificant";
  const t = Math.abs(tStat);
  if (t >= 2.0) return "significant";
  if (t >= 1.0) return "marginal";
  return "insignificant";
}

/**
 * Aggregate `rows` by sector, returning per-(sector, factor) mean + t-stat
 * + significance bucket. Caller passes the already-filtered surviving rows.
 */
export function aggregateBySectorFactor(args: {
  rows: ReadonlyArray<PerStockRow>;
  factors: ReadonlyArray<FactorCode>;
  metric: FactorGridMetric;
  filters: FactorScreenerFilters;
}): SectorHeatmapResult {
  const { rows, factors, metric, filters } = args;

  // Bucket rows by sector once.
  const rowsBySector = new Map<string, PerStockRow[]>();
  for (const r of rows) {
    let arr = rowsBySector.get(r.sector);
    if (!arr) {
      arr = [];
      rowsBySector.set(r.sector, arr);
    }
    arr.push(r);
  }

  const bySector = new Map<string, Map<FactorCode, SectorFactorAggregate | null>>();

  for (const [sector, sectorRows] of rowsBySector) {
    const inner = new Map<FactorCode, SectorFactorAggregate | null>();
    for (const code of factors) {
      // Collect contributing values: sig-gate masks excluded, missing
      // factor cells excluded, non-finite values excluded.
      const values: number[] = [];
      for (const r of sectorRows) {
        if (filters.sigGate.enabled && !sigGatePassed(r, code, filters)) continue;
        const v = factorCellValue(r.cells[code], metric);
        if (v === null) continue;
        values.push(v);
      }

      if (values.length < MIN_SECTOR_HEATMAP_N) {
        inner.set(code, null);
        continue;
      }

      const n = values.length;
      let sum = 0;
      for (const v of values) sum += v;
      const mean = sum / n;

      let sumSq = 0;
      for (const v of values) {
        const d = v - mean;
        sumSq += d * d;
      }
      const variance = n > 1 ? sumSq / (n - 1) : 0;
      const sd = Math.sqrt(Math.max(0, variance));
      const se = sd > 0 ? sd / Math.sqrt(n) : 0;
      const tStat = se > 0 ? mean / se : Number.NaN;

      inner.set(code, {
        mean,
        n,
        tStat,
        significance: classifySignificance(tStat),
      });
    }
    bySector.set(sector, inner);
  }

  const sectors = [...bySector.keys()].sort();
  return { bySector, sectors, factors: [...factors] };
}
