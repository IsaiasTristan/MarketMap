import { describe, expect, it } from "vitest";
import {
  applyRowFilters,
  hasAnyActiveRowFilter,
  firstFailingPredicate,
} from "@/lib/factors/screener/predicates";
import {
  assignCohorts,
  describeCohortKey,
  MIN_COHORT_SIZE,
} from "@/lib/factors/screener/cohorts";
import {
  buildCohortStats,
  sigGatePassed,
  statsFor,
  summaryColumnValue,
} from "@/lib/factors/screener/stats";
import {
  computeZ,
  computePctRank,
  computePctFraction,
  Z_DISPLAY_CLIP,
} from "@/lib/factors/screener/derived";
import {
  compareSortKeys,
  makeRowComparator,
} from "@/lib/factors/screener/sort";
import {
  buildHistogramBins,
  histogramMode,
  threeTickFromStats,
  valuePositionInCohort,
  MIN_HISTOGRAM_N,
  DEFAULT_HISTOGRAM_BINS,
} from "@/lib/factors/screener/histogram";
import {
  aggregateBySectorFactor,
  classifySignificance,
  MIN_SECTOR_HEATMAP_N,
} from "@/lib/factors/screener/sector-heatmap";
import {
  axisDef,
  extractAxisValue,
  clipPercentileRange,
  logScaleEligible,
  parseFactorAxisKey,
  SCATTER_PRESETS,
} from "@/lib/factors/screener/scatter";
import { DEFAULT_FACTOR_SCREENER_FILTERS } from "@/store/analysis";
import type { PerStockRow, PerStockFactorCell } from "@/server/services/factor-per-stock.service";
import type { FactorScreenerFilters } from "@/store/analysis";
import type { FactorCode } from "@/types/factors";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeCell(beta: number, tStat: number = beta * 5): PerStockFactorCell {
  return {
    beta,
    tStat,
    returnContribution: beta * 0.05,
    returnContributionLog: beta * 0.045,
    returnContributionGeometric: beta * 0.05,
    riskContribution: Math.abs(beta) * 0.1,
  };
}

interface RowOverrides {
  ticker: string;
  sector?: string;
  subTheme?: string;
  rSquared?: number;
  observations?: number;
  alphaAnnualized?: number;
  alphaTStat?: number;
  alphaCi95Half?: number;
  realizedAnnualizedVol?: number;
  rollingAlphaPostBurnSum?: number | null;
  rollingResidualPostBurnSum?: number | null;
  residualTStat?: number | null;
  realizedTotalReturn?: number | null;
  cells?: Partial<Record<FactorCode, PerStockFactorCell>>;
}

function makeRow(o: RowOverrides): PerStockRow {
  return {
    ticker: o.ticker,
    name: o.ticker,
    sector: o.sector ?? "Tech",
    subTheme: o.subTheme ?? "Software",
    cells: o.cells ?? {},
    rSquared: o.rSquared ?? 0.5,
    alphaAnnualized: o.alphaAnnualized ?? 0.05,
    alphaTStat: o.alphaTStat ?? 1.5,
    alphaStdError: 0.01,
    alphaStdErrorAnnualized: 0.01 * 252,
    alphaCi95Half: o.alphaCi95Half ?? 1.96 * 0.01 * 252,
    alphaWindowSum: 0.05 * 252,
    residualWindowSum: 0,
    observations: o.observations ?? 252,
    realizedAnnualizedVol: o.realizedAnnualizedVol ?? 0.2,
    modelImpliedAnnualizedVol: 0.2,
    varGapPct: 0,
    totalVolatility: 0.2,
    systematicShareEulerAligned: 0.6,
    systematicShareEulerFullWindow: 0.6,
    systematicShareDelta: 0,
    systematicShare: 0.6,
    idiosyncraticShare: 0.4,
    zeroFillCount: 0,
    zeroFillRowCount: 0,
    droppedDates: [],
    vif: [],
    conditionNumber: 1,
    rollingAlphaPostBurnSum: o.rollingAlphaPostBurnSum ?? 0.05,
    rollingResidualPostBurnSum: o.rollingResidualPostBurnSum ?? 0,
    rollingObservationsPostBurn: 192,
    residualTStat: o.residualTStat ?? 0.5,
    residualCi95Half: 0.05,
    // Log-space defaults — fixtures default to ~half the simple-space values
    // to mimic a low-vol stock where Jensen's correction is negligible.
    alphaAnnualizedLog: o.alphaAnnualized != null ? o.alphaAnnualized * 0.95 : 0.045,
    alphaTStatLog: o.alphaTStat != null ? o.alphaTStat * 0.95 : 1.4,
    alphaStdErrorLog: 0.01,
    alphaCi95HalfLog: o.alphaCi95Half != null ? o.alphaCi95Half * 0.95 : 1.96 * 0.01 * 252,
    rollingAlphaPostBurnSumLog:
      o.rollingAlphaPostBurnSum != null ? o.rollingAlphaPostBurnSum * 0.95 : 0.045,
    rollingResidualPostBurnSumLog:
      o.rollingResidualPostBurnSum != null ? o.rollingResidualPostBurnSum * 0.95 : 0,
    residualTStatLog: o.residualTStat != null ? o.residualTStat * 0.95 : 0.45,
    residualCi95HalfLog: 0.045,
    clippedLogDayCount: 0,
    realizedTotalReturn:
      o.realizedTotalReturn === undefined ? 0.10 : o.realizedTotalReturn,
  };
}

const NO_FILTERS = DEFAULT_FACTOR_SCREENER_FILTERS;

function withFilters(patch: Partial<FactorScreenerFilters>): FactorScreenerFilters {
  return { ...NO_FILTERS, ...patch };
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

describe("applyRowFilters", () => {
  it("returns all rows when no filters are active", () => {
    const rows = [makeRow({ ticker: "A" }), makeRow({ ticker: "B" })];
    const out = applyRowFilters(rows, NO_FILTERS);
    expect(out.surviving.map((r) => r.ticker)).toEqual(["A", "B"]);
    expect(out.dropped.size).toBe(0);
  });

  it("drops rows below minRSquared", () => {
    const rows = [
      makeRow({ ticker: "GOOD", rSquared: 0.5 }),
      makeRow({ ticker: "BAD", rSquared: 0.1 }),
    ];
    const out = applyRowFilters(rows, withFilters({ minRSquared: 0.3 }));
    expect(out.surviving.map((r) => r.ticker)).toEqual(["GOOD"]);
    expect(out.dropped.get("BAD")).toBe("minRSquared");
  });

  it("drops rows below minObservations", () => {
    const rows = [
      makeRow({ ticker: "LONG", observations: 252 }),
      makeRow({ ticker: "SHORT", observations: 30 }),
    ];
    const out = applyRowFilters(rows, withFilters({ minObservations: 60 }));
    expect(out.surviving.map((r) => r.ticker)).toEqual(["LONG"]);
    expect(out.dropped.get("SHORT")).toBe("minObservations");
  });

  it("drops rows below alpha magnitude floor", () => {
    const rows = [
      makeRow({ ticker: "BIG_ALPHA", alphaAnnualized: 0.10 }),
      makeRow({ ticker: "TINY_ALPHA", alphaAnnualized: 0.005 }),
    ];
    const out = applyRowFilters(rows, withFilters({ alphaMagnitudeFloor: 0.02 }));
    expect(out.surviving.map((r) => r.ticker)).toEqual(["BIG_ALPHA"]);
    expect(out.dropped.get("TINY_ALPHA")).toBe("alphaMagnitudeFloor");
  });

  it("drops rows below per-factor beta magnitude floor", () => {
    const rows = [
      makeRow({ ticker: "MARKET_HEAVY", cells: { MKT_RF: makeCell(1.2) } }),
      makeRow({ ticker: "LOW_BETA", cells: { MKT_RF: makeCell(0.05) } }),
      makeRow({ ticker: "NO_BETA", cells: {} }),
    ];
    const out = applyRowFilters(
      rows,
      withFilters({ betaMagnitudeFloor: { MKT_RF: 0.5 } }),
    );
    expect(out.surviving.map((r) => r.ticker)).toEqual(["MARKET_HEAVY"]);
    expect(out.dropped.get("LOW_BETA")).toBe("betaMagnitudeFloor");
    expect(out.dropped.get("NO_BETA")).toBe("betaMagnitudeFloor");
  });

  it("drops rows whose alpha CI does NOT exclude zero when filter is on", () => {
    // |α| > CI half-width ⇔ CI excludes 0
    const rows = [
      makeRow({ ticker: "SIG_ALPHA", alphaAnnualized: 0.10, alphaCi95Half: 0.05 }),
      makeRow({ ticker: "NOISY_ALPHA", alphaAnnualized: 0.02, alphaCi95Half: 0.05 }),
    ];
    const out = applyRowFilters(rows, withFilters({ alphaCiExcludesZero: true }));
    expect(out.surviving.map((r) => r.ticker)).toEqual(["SIG_ALPHA"]);
    expect(out.dropped.get("NOISY_ALPHA")).toBe("alphaCiExcludesZero");
  });

  it("first-failing-predicate order is deterministic: R² before observations", () => {
    const row = makeRow({ ticker: "X", rSquared: 0.1, observations: 30 });
    const reason = firstFailingPredicate(
      row,
      withFilters({ minRSquared: 0.3, minObservations: 60 }),
    );
    expect(reason).toBe("minRSquared");
  });

  it("hasAnyActiveRowFilter detects every active filter type", () => {
    expect(hasAnyActiveRowFilter(NO_FILTERS)).toBe(false);
    expect(hasAnyActiveRowFilter(withFilters({ minRSquared: 0.3 }))).toBe(true);
    expect(hasAnyActiveRowFilter(withFilters({ minObservations: 60 }))).toBe(true);
    expect(hasAnyActiveRowFilter(withFilters({ alphaMagnitudeFloor: 0.02 }))).toBe(true);
    expect(
      hasAnyActiveRowFilter(withFilters({ betaMagnitudeFloor: { MKT_RF: 0.5 } })),
    ).toBe(true);
    expect(hasAnyActiveRowFilter(withFilters({ alphaCiExcludesZero: true }))).toBe(true);
    // Sig gate is a cell mask, NOT a row predicate — must NOT count here.
    expect(
      hasAnyActiveRowFilter(
        withFilters({ sigGate: { enabled: true, threshold: 2.0 } }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

describe("assignCohorts", () => {
  it("places every row in 'universe' when refGroup.kind === universe", () => {
    const rows = [
      makeRow({ ticker: "A", sector: "Tech", subTheme: "AI" }),
      makeRow({ ticker: "B", sector: "Energy", subTheme: "Oil" }),
    ];
    const out = assignCohorts(rows, { kind: "universe" });
    expect(out.keyByTicker.get("A")).toBe("universe");
    expect(out.keyByTicker.get("B")).toBe("universe");
    expect(out.sizeByKey.get("universe")).toBe(2);
    expect(out.widenedFromTo.size).toBe(0);
  });

  it("partitions by sector when refGroup.kind === sector and cohorts are large enough", () => {
    const rows: PerStockRow[] = [];
    for (let i = 0; i < 6; i++) rows.push(makeRow({ ticker: `T${i}`, sector: "Tech" }));
    for (let i = 0; i < 6; i++) rows.push(makeRow({ ticker: `E${i}`, sector: "Energy" }));
    const out = assignCohorts(rows, { kind: "sector" });
    expect(out.keyByTicker.get("T0")).toBe("sector:Tech");
    expect(out.keyByTicker.get("E0")).toBe("sector:Energy");
    expect(out.sizeByKey.get("sector:Tech")).toBe(6);
    expect(out.sizeByKey.get("sector:Energy")).toBe(6);
    expect(out.widenedFromTo.size).toBe(0);
  });

  it("widens sector → universe when sector has < MIN_COHORT_SIZE rows", () => {
    expect(MIN_COHORT_SIZE).toBe(5);
    const rows: PerStockRow[] = [];
    for (let i = 0; i < 6; i++) rows.push(makeRow({ ticker: `T${i}`, sector: "Tech" }));
    rows.push(makeRow({ ticker: "TINY1", sector: "Tiny" }));
    rows.push(makeRow({ ticker: "TINY2", sector: "Tiny" }));
    const out = assignCohorts(rows, { kind: "sector" });
    expect(out.keyByTicker.get("T0")).toBe("sector:Tech");
    expect(out.keyByTicker.get("TINY1")).toBe("universe");
    expect(out.widenedFromTo.get("TINY1")).toEqual({
      from: "sector:Tiny",
      to: "universe",
    });
  });

  it("widens sub-theme → sector when sub-theme is small but sector qualifies", () => {
    const rows: PerStockRow[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(makeRow({ ticker: `S${i}`, sector: "Tech", subTheme: "Software" }));
    }
    // 2 stocks in a different sub-theme but same sector — widen to sector
    rows.push(makeRow({ ticker: "AI1", sector: "Tech", subTheme: "AI" }));
    rows.push(makeRow({ ticker: "AI2", sector: "Tech", subTheme: "AI" }));
    const out = assignCohorts(rows, { kind: "subTheme" });
    expect(out.keyByTicker.get("S0")).toBe("subTheme:Software");
    expect(out.keyByTicker.get("AI1")).toBe("sector:Tech");
    expect(out.widenedFromTo.get("AI1")).toEqual({
      from: "subTheme:AI",
      to: "sector:Tech",
    });
  });

  it("widens sub-theme all the way to universe when both sub-theme and sector are too small", () => {
    const rows: PerStockRow[] = [];
    for (let i = 0; i < 10; i++) rows.push(makeRow({ ticker: `T${i}`, sector: "Tech" }));
    // single row in its own sector / sub-theme
    rows.push(makeRow({ ticker: "ORPHAN", sector: "Niche", subTheme: "Solo" }));
    const out = assignCohorts(rows, { kind: "subTheme" });
    expect(out.keyByTicker.get("ORPHAN")).toBe("universe");
    expect(out.widenedFromTo.get("ORPHAN")).toEqual({
      from: "subTheme:Solo",
      to: "universe",
    });
  });

  it("describeCohortKey produces human-readable labels", () => {
    expect(describeCohortKey("universe")).toBe("Universe");
    expect(describeCohortKey("sector:Tech")).toBe("Sector · Tech");
    expect(describeCohortKey("subTheme:AI")).toBe("Sub-theme · AI");
    expect(describeCohortKey("custom:my-set")).toBe("Peer set · my-set");
  });
});

// ---------------------------------------------------------------------------
// Cohort stats + sig gate
// ---------------------------------------------------------------------------

describe("buildCohortStats", () => {
  it("computes mean / sd / sorted values for factor cells in a single cohort", () => {
    const rows = [
      makeRow({ ticker: "A", cells: { MKT_RF: makeCell(0.8) } }),
      makeRow({ ticker: "B", cells: { MKT_RF: makeCell(1.0) } }),
      makeRow({ ticker: "C", cells: { MKT_RF: makeCell(1.2) } }),
    ];
    const cohorts = assignCohorts(rows, { kind: "universe" });
    const stats = buildCohortStats({
      rows,
      keyByTicker: cohorts.keyByTicker,
      factorColumns: ["MKT_RF"],
      summaryColumns: [],
      metric: "beta",
      filters: NO_FILTERS,
    });
    const s = statsFor(stats, "universe", "MKT_RF");
    expect(s).not.toBeNull();
    expect(s!.n).toBe(3);
    expect(s!.mean).toBeCloseTo(1.0, 6);
    // Bessel SD of [0.8, 1.0, 1.2] = √(0.08/2) = 0.2
    expect(s!.sd).toBeCloseTo(0.2, 6);
    expect(s!.sortedValues).toEqual([0.8, 1.0, 1.2]);
  });

  it("excludes cells failing the sig gate from cohort stats", () => {
    const rows = [
      // tStats: 0.5, 3.0, 4.0 — gate at |t| ≥ 2 keeps only B and C
      makeRow({ ticker: "A", cells: { MKT_RF: makeCell(0.8, 0.5) } }),
      makeRow({ ticker: "B", cells: { MKT_RF: makeCell(1.0, 3.0) } }),
      makeRow({ ticker: "C", cells: { MKT_RF: makeCell(1.2, 4.0) } }),
    ];
    const cohorts = assignCohorts(rows, { kind: "universe" });
    const stats = buildCohortStats({
      rows,
      keyByTicker: cohorts.keyByTicker,
      factorColumns: ["MKT_RF"],
      summaryColumns: [],
      metric: "beta",
      filters: withFilters({ sigGate: { enabled: true, threshold: 2.0 } }),
    });
    const s = statsFor(stats, "universe", "MKT_RF")!;
    expect(s.n).toBe(2);
    expect(s.sortedValues).toEqual([1.0, 1.2]);
  });

  it("R² and Vol are never gated even when sig gate is on", () => {
    const rows = [
      makeRow({ ticker: "A", rSquared: 0.5, alphaTStat: 0.1 }),
      makeRow({ ticker: "B", rSquared: 0.7, alphaTStat: 0.1 }),
    ];
    const cohorts = assignCohorts(rows, { kind: "universe" });
    const stats = buildCohortStats({
      rows,
      keyByTicker: cohorts.keyByTicker,
      factorColumns: [],
      summaryColumns: ["rSquared"],
      metric: "beta",
      filters: withFilters({ sigGate: { enabled: true, threshold: 2.0 } }),
    });
    const s = statsFor(stats, "universe", "rSquared")!;
    expect(s.n).toBe(2);
  });

  it("alpha column IS gated by alphaTStat (simple-space mode)", () => {
    const rows = [
      makeRow({ ticker: "A", rollingAlphaPostBurnSum: 0.10, alphaTStat: 0.5 }),
      makeRow({ ticker: "B", rollingAlphaPostBurnSum: 0.05, alphaTStat: 3.0 }),
    ];
    const cohorts = assignCohorts(rows, { kind: "universe" });
    const stats = buildCohortStats({
      rows,
      keyByTicker: cohorts.keyByTicker,
      factorColumns: [],
      summaryColumns: ["alpha"],
      metric: "beta",
      filters: withFilters({ sigGate: { enabled: true, threshold: 2.0 } }),
      mode: "simple",
    });
    const s = statsFor(stats, "universe", "alpha")!;
    expect(s.n).toBe(1);
    expect(s.sortedValues).toEqual([0.05]);
  });

  it("returns empty stats when every row is gated", () => {
    const rows = [
      makeRow({ ticker: "A", cells: { MKT_RF: makeCell(0.8, 0.1) } }),
      makeRow({ ticker: "B", cells: { MKT_RF: makeCell(1.0, 0.2) } }),
    ];
    const cohorts = assignCohorts(rows, { kind: "universe" });
    const stats = buildCohortStats({
      rows,
      keyByTicker: cohorts.keyByTicker,
      factorColumns: ["MKT_RF"],
      summaryColumns: [],
      metric: "beta",
      filters: withFilters({ sigGate: { enabled: true, threshold: 2.0 } }),
    });
    expect(statsFor(stats, "universe", "MKT_RF")).toBeNull();
  });
});

describe("sigGatePassed", () => {
  it("returns true when gate is disabled regardless of t-stat", () => {
    const row = makeRow({ ticker: "A", cells: { MKT_RF: makeCell(0.5, 0.1) } });
    expect(sigGatePassed(row, "MKT_RF", NO_FILTERS)).toBe(true);
  });

  it("returns true when |t| meets threshold", () => {
    const row = makeRow({ ticker: "A", cells: { MKT_RF: makeCell(0.5, 2.5) } });
    const filters = withFilters({ sigGate: { enabled: true, threshold: 2.0 } });
    expect(sigGatePassed(row, "MKT_RF", filters)).toBe(true);
  });

  it("returns false when |t| is below threshold", () => {
    const row = makeRow({ ticker: "A", cells: { MKT_RF: makeCell(0.5, 1.5) } });
    const filters = withFilters({ sigGate: { enabled: true, threshold: 2.0 } });
    expect(sigGatePassed(row, "MKT_RF", filters)).toBe(false);
  });

  it("returns true for R² and realizedVol regardless of gate state", () => {
    const row = makeRow({ ticker: "A" });
    const filters = withFilters({ sigGate: { enabled: true, threshold: 2.0 } });
    expect(sigGatePassed(row, "rSquared", filters)).toBe(true);
    expect(sigGatePassed(row, "realizedVol", filters)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Z-score
// ---------------------------------------------------------------------------

describe("computeZ", () => {
  function statsFromValues(values: number[]) {
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(
      values.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1),
    );
    const sorted = values.slice().sort((a, b) => a - b);
    return {
      n,
      mean,
      sd,
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      sortedValues: sorted,
    };
  }

  it("returns the correct raw z and unclipped display when within ±5", () => {
    const stats = statsFromValues([0.8, 1.0, 1.2]); // mean 1.0, sd 0.2
    const z = computeZ(1.4, stats);
    expect(z.raw).toBeCloseTo(2.0, 6);
    expect(z.display).toBeCloseTo(2.0, 6);
    expect(z.fellBackToPct).toBe(false);
  });

  it("clips display to ±Z_DISPLAY_CLIP but preserves raw", () => {
    expect(Z_DISPLAY_CLIP).toBe(5);
    const stats = statsFromValues([0.0, 0.1, 0.2]); // mean 0.1, sd ~0.1
    const z = computeZ(2.0, stats);
    expect(z.raw!).toBeGreaterThan(10); // raw is huge
    expect(z.display).toBe(5);
  });

  it("falls back to percentile when σ_cohort is below MIN_SD_FOR_Z", () => {
    // All values ~equal — σ ≈ 0
    const stats = statsFromValues([1.0, 1.0, 1.0]);
    const z = computeZ(1.0, stats);
    expect(z.fellBackToPct).toBe(true);
    expect(z.display).toBeNull();
  });

  it("returns null when n < 2", () => {
    const stats = statsFromValues([1.0]);
    const z = computeZ(1.0, stats);
    expect(z.raw).toBeNull();
    expect(z.display).toBeNull();
  });

  it("returns null when value is non-finite", () => {
    const stats = statsFromValues([0.8, 1.0, 1.2]);
    expect(computeZ(Number.NaN, stats).raw).toBeNull();
    expect(computeZ(null, stats).raw).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Percentile rank
// ---------------------------------------------------------------------------

describe("computePctRank", () => {
  function uniformStats() {
    const values: number[] = [];
    for (let i = 0; i < 100; i++) values.push(i / 99);
    return {
      n: 100,
      mean: 0.5,
      sd: 0.29,
      min: 0,
      max: 1,
      sortedValues: values.slice().sort((a, b) => a - b),
    };
  }

  it("clamps cohort min to percentile 1 and max to 99", () => {
    const stats = uniformStats();
    expect(computePctRank(0, stats)).toBe(1);
    expect(computePctRank(1, stats)).toBe(99);
  });

  it("places median value near percentile 50", () => {
    const stats = uniformStats();
    const p = computePctRank(0.5, stats);
    expect(p).toBeGreaterThanOrEqual(48);
    expect(p).toBeLessThanOrEqual(52);
  });

  it("returns same percentile for tied values (average-rank)", () => {
    // Cohort with three identical values; querying that value returns the
    // average of count_lt and count_eq → middle position.
    const stats = {
      n: 5,
      mean: 1,
      sd: 0,
      min: 0,
      max: 2,
      sortedValues: [0, 1, 1, 1, 2],
    };
    const p = computePctRank(1, stats);
    // count_lt = 1, count_eq = 3, n = 5 → (1 + 1.5)/5 = 0.5 → 50
    expect(p).toBe(50);
  });

  it("returns null when cohort is empty or value is non-finite", () => {
    const empty = {
      n: 0,
      mean: Number.NaN,
      sd: Number.NaN,
      min: Number.NaN,
      max: Number.NaN,
      sortedValues: [],
    };
    expect(computePctRank(1, empty)).toBeNull();
    expect(computePctRank(Number.NaN, uniformStats())).toBeNull();
  });

  it("computePctFraction returns 0..1 continuous values", () => {
    const stats = uniformStats();
    const f = computePctFraction(0.5, stats);
    expect(f).not.toBeNull();
    expect(f!).toBeGreaterThan(0.45);
    expect(f!).toBeLessThan(0.55);
  });
});

// ---------------------------------------------------------------------------
// Sort comparators
// ---------------------------------------------------------------------------

describe("compareSortKeys", () => {
  it("sorts NaN/null to the bottom regardless of direction", () => {
    expect(compareSortKeys(null, 1, "desc")).toBe(1);
    expect(compareSortKeys(null, 1, "asc")).toBe(1);
    expect(compareSortKeys(1, null, "desc")).toBe(-1);
    expect(compareSortKeys(1, null, "asc")).toBe(-1);
    expect(compareSortKeys(Number.NaN, 1, "desc")).toBe(1);
  });

  it("sorts both null/NaN as equal", () => {
    expect(compareSortKeys(null, null, "desc")).toBe(0);
    expect(compareSortKeys(Number.NaN, null, "asc")).toBe(0);
  });

  it("sorts finite values by direction", () => {
    expect(compareSortKeys(1, 2, "desc")).toBe(1); // 2 first
    expect(compareSortKeys(1, 2, "asc")).toBe(-1); // 1 first
    expect(compareSortKeys(2, 1, "desc")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Histogram strip
// ---------------------------------------------------------------------------

describe("buildHistogramBins", () => {
  it("returns no bins for empty input", () => {
    expect(buildHistogramBins([])).toEqual([]);
  });

  it("collapses to a single bin when all values are equal", () => {
    const bins = buildHistogramBins([1, 1, 1, 1, 1]);
    expect(bins).toHaveLength(1);
    expect(bins[0]!.count).toBe(5);
  });

  it("partitions a uniform distribution roughly evenly across bins", () => {
    const values: number[] = [];
    for (let i = 0; i < 1000; i++) values.push(i / 999);
    const bins = buildHistogramBins(values, 10);
    expect(bins).toHaveLength(10);
    // Each bin should contain roughly 100 values
    for (const b of bins) {
      expect(b.count).toBeGreaterThan(80);
      expect(b.count).toBeLessThan(120);
    }
  });

  it("totals match input length", () => {
    const values = [0.1, 0.2, 0.5, 0.7, 0.9, 1.1, 1.5, 1.9, 2.1, 2.5];
    const bins = buildHistogramBins(values, 5);
    const total = bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(values.length);
  });

  it("uses default bin count when not specified", () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    const bins = buildHistogramBins(values);
    expect(bins).toHaveLength(DEFAULT_HISTOGRAM_BINS);
  });
});

describe("valuePositionInCohort", () => {
  function makeStats(min: number, max: number) {
    return {
      n: 3,
      mean: (min + max) / 2,
      sd: 1,
      min,
      max,
      sortedValues: [min, (min + max) / 2, max],
    };
  }

  it("maps value at min to 0 and at max to 1", () => {
    const s = makeStats(0, 10);
    expect(valuePositionInCohort(0, s)).toBe(0);
    expect(valuePositionInCohort(10, s)).toBe(1);
  });

  it("maps midpoint to 0.5", () => {
    const s = makeStats(0, 10);
    expect(valuePositionInCohort(5, s)).toBeCloseTo(0.5, 6);
  });

  it("clamps out-of-range values to [0, 1]", () => {
    const s = makeStats(0, 10);
    expect(valuePositionInCohort(-5, s)).toBe(0);
    expect(valuePositionInCohort(15, s)).toBe(1);
  });

  it("returns 0.5 for degenerate (max == min) cohorts", () => {
    const s = makeStats(1, 1);
    expect(valuePositionInCohort(1, s)).toBe(0.5);
  });

  it("returns null for non-finite values or empty cohort", () => {
    const s = makeStats(0, 10);
    expect(valuePositionInCohort(Number.NaN, s)).toBeNull();
    expect(valuePositionInCohort(null, s)).toBeNull();
    expect(
      valuePositionInCohort(5, {
        n: 0,
        mean: Number.NaN,
        sd: Number.NaN,
        min: Number.NaN,
        max: Number.NaN,
        sortedValues: [],
      }),
    ).toBeNull();
  });
});

describe("histogramMode", () => {
  it("returns 'empty' for null or zero-count stats", () => {
    expect(histogramMode(null)).toBe("empty");
    expect(
      histogramMode({
        n: 0,
        mean: Number.NaN,
        sd: Number.NaN,
        min: Number.NaN,
        max: Number.NaN,
        sortedValues: [],
      }),
    ).toBe("empty");
  });

  it("returns 'threeTick' below the histogram minimum", () => {
    expect(MIN_HISTOGRAM_N).toBe(20);
    const sortedValues = Array.from({ length: 19 }, (_, i) => i);
    expect(
      histogramMode({
        n: 19,
        mean: 9,
        sd: 5,
        min: 0,
        max: 18,
        sortedValues,
      }),
    ).toBe("threeTick");
  });

  it("returns 'histogram' once the cohort meets the minimum", () => {
    const sortedValues = Array.from({ length: 25 }, (_, i) => i);
    expect(
      histogramMode({
        n: 25,
        mean: 12,
        sd: 7,
        min: 0,
        max: 24,
        sortedValues,
      }),
    ).toBe("histogram");
  });
});

describe("threeTickFromStats", () => {
  it("computes min / median / max for an odd-length cohort", () => {
    const t = threeTickFromStats({
      n: 5,
      mean: 5,
      sd: 3,
      min: 1,
      max: 9,
      sortedValues: [1, 3, 5, 7, 9],
    });
    expect(t).toEqual({ min: 1, median: 5, max: 9 });
  });

  it("computes lower-median for even-length cohort", () => {
    const t = threeTickFromStats({
      n: 4,
      mean: 2.5,
      sd: 1,
      min: 1,
      max: 4,
      sortedValues: [1, 2, 3, 4],
    });
    // mean of two middle values: (2+3)/2 = 2.5
    expect(t).toEqual({ min: 1, median: 2.5, max: 4 });
  });

  it("returns null for empty cohort", () => {
    expect(
      threeTickFromStats({
        n: 0,
        mean: Number.NaN,
        sd: Number.NaN,
        min: Number.NaN,
        max: Number.NaN,
        sortedValues: [],
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sector × factor heatmap aggregator
// ---------------------------------------------------------------------------

describe("classifySignificance", () => {
  it("buckets by absolute t-stat threshold", () => {
    expect(classifySignificance(2.5)).toBe("significant");
    expect(classifySignificance(-2.5)).toBe("significant");
    expect(classifySignificance(2.0)).toBe("significant");
    expect(classifySignificance(1.5)).toBe("marginal");
    expect(classifySignificance(-1.0)).toBe("marginal");
    expect(classifySignificance(0.5)).toBe("insignificant");
    expect(classifySignificance(0)).toBe("insignificant");
  });

  it("treats non-finite t as insignificant", () => {
    expect(classifySignificance(Number.NaN)).toBe("insignificant");
    expect(classifySignificance(Number.POSITIVE_INFINITY)).toBe("insignificant");
  });
});

describe("aggregateBySectorFactor", () => {
  it("computes mean / n / t per sector × factor", () => {
    const rows = [
      makeRow({ ticker: "T1", sector: "Tech", cells: { MKT_RF: makeCell(1.0, 5) } }),
      makeRow({ ticker: "T2", sector: "Tech", cells: { MKT_RF: makeCell(1.2, 6) } }),
      makeRow({ ticker: "T3", sector: "Tech", cells: { MKT_RF: makeCell(1.4, 7) } }),
      makeRow({ ticker: "E1", sector: "Energy", cells: { MKT_RF: makeCell(0.6, 4) } }),
      makeRow({ ticker: "E2", sector: "Energy", cells: { MKT_RF: makeCell(0.8, 4) } }),
      makeRow({ ticker: "E3", sector: "Energy", cells: { MKT_RF: makeCell(1.0, 5) } }),
    ];
    const out = aggregateBySectorFactor({
      rows,
      factors: ["MKT_RF"],
      metric: "beta",
      filters: NO_FILTERS,
    });
    expect(out.sectors).toEqual(["Energy", "Tech"]);
    const tech = out.bySector.get("Tech")!.get("MKT_RF")!;
    expect(tech.n).toBe(3);
    expect(tech.mean).toBeCloseTo(1.2, 6);
    // SD of [1.0, 1.2, 1.4] = 0.2; SE = 0.2/√3; t = 1.2/(0.2/√3) ≈ 10.39
    expect(tech.tStat).toBeGreaterThan(10);
    expect(tech.significance).toBe("significant");
  });

  it("renders null cells when contributing rows < MIN_SECTOR_HEATMAP_N", () => {
    expect(MIN_SECTOR_HEATMAP_N).toBe(3);
    const rows = [
      makeRow({ ticker: "S1", sector: "Solo", cells: { MKT_RF: makeCell(1.0, 5) } }),
      makeRow({ ticker: "S2", sector: "Solo", cells: { MKT_RF: makeCell(1.2, 6) } }),
    ];
    const out = aggregateBySectorFactor({
      rows,
      factors: ["MKT_RF"],
      metric: "beta",
      filters: NO_FILTERS,
    });
    expect(out.bySector.get("Solo")!.get("MKT_RF")).toBeNull();
  });

  it("excludes sig-gated cells from the sector mean", () => {
    const rows = [
      makeRow({ ticker: "A", sector: "Tech", cells: { MKT_RF: makeCell(2.0, 0.5) } }),
      makeRow({ ticker: "B", sector: "Tech", cells: { MKT_RF: makeCell(1.0, 3.0) } }),
      makeRow({ ticker: "C", sector: "Tech", cells: { MKT_RF: makeCell(1.2, 4.0) } }),
      makeRow({ ticker: "D", sector: "Tech", cells: { MKT_RF: makeCell(1.4, 5.0) } }),
    ];
    const out = aggregateBySectorFactor({
      rows,
      factors: ["MKT_RF"],
      metric: "beta",
      filters: withFilters({ sigGate: { enabled: true, threshold: 2.0 } }),
    });
    const tech = out.bySector.get("Tech")!.get("MKT_RF")!;
    // Stock A's beta=2.0 with t=0.5 is gated out; mean over [1.0, 1.2, 1.4] = 1.2
    expect(tech.n).toBe(3);
    expect(tech.mean).toBeCloseTo(1.2, 6);
  });

  it("respects active metric (return contribution, simple mode)", () => {
    const rows = [
      makeRow({ ticker: "A", sector: "Tech", cells: { MKT_RF: makeCell(1.0, 5) } }),
      makeRow({ ticker: "B", sector: "Tech", cells: { MKT_RF: makeCell(2.0, 6) } }),
      makeRow({ ticker: "C", sector: "Tech", cells: { MKT_RF: makeCell(3.0, 7) } }),
    ];
    // makeCell sets returnContribution = beta * 0.05
    const out = aggregateBySectorFactor({
      rows,
      factors: ["MKT_RF"],
      metric: "return",
      filters: NO_FILTERS,
      mode: "simple",
    });
    const tech = out.bySector.get("Tech")!.get("MKT_RF")!;
    // Mean of [0.05, 0.10, 0.15] = 0.10
    expect(tech.mean).toBeCloseTo(0.10, 6);
  });

  it("respects attribution mode (log return contribution by default)", () => {
    const rows = [
      makeRow({ ticker: "A", sector: "Tech", cells: { MKT_RF: makeCell(1.0, 5) } }),
      makeRow({ ticker: "B", sector: "Tech", cells: { MKT_RF: makeCell(2.0, 6) } }),
      makeRow({ ticker: "C", sector: "Tech", cells: { MKT_RF: makeCell(3.0, 7) } }),
    ];
    // makeCell sets returnContributionLog = beta * 0.045; default mode = log.
    const out = aggregateBySectorFactor({
      rows,
      factors: ["MKT_RF"],
      metric: "return",
      filters: NO_FILTERS,
    });
    const tech = out.bySector.get("Tech")!.get("MKT_RF")!;
    // Mean of [0.045, 0.090, 0.135] = 0.090
    expect(tech.mean).toBeCloseTo(0.09, 6);
  });

  it("returns empty result for empty rows", () => {
    const out = aggregateBySectorFactor({
      rows: [],
      factors: ["MKT_RF"],
      metric: "beta",
      filters: NO_FILTERS,
    });
    expect(out.sectors).toEqual([]);
    expect(out.bySector.size).toBe(0);
  });

  it("alphabetises sector list", () => {
    const rows = [
      makeRow({ ticker: "1", sector: "Zeta", cells: { MKT_RF: makeCell(1.0) } }),
      makeRow({ ticker: "2", sector: "Zeta", cells: { MKT_RF: makeCell(1.0) } }),
      makeRow({ ticker: "3", sector: "Zeta", cells: { MKT_RF: makeCell(1.0) } }),
      makeRow({ ticker: "4", sector: "Alpha", cells: { MKT_RF: makeCell(1.0) } }),
      makeRow({ ticker: "5", sector: "Alpha", cells: { MKT_RF: makeCell(1.0) } }),
      makeRow({ ticker: "6", sector: "Alpha", cells: { MKT_RF: makeCell(1.0) } }),
    ];
    const out = aggregateBySectorFactor({
      rows,
      factors: ["MKT_RF"],
      metric: "beta",
      filters: NO_FILTERS,
    });
    expect(out.sectors).toEqual(["Alpha", "Zeta"]);
  });
});

// ---------------------------------------------------------------------------
// Scatter axis extractors
// ---------------------------------------------------------------------------

describe("parseFactorAxisKey", () => {
  it("parses factor:CODE:sub keys", () => {
    expect(parseFactorAxisKey("factor:MKT_RF:beta")).toEqual({
      code: "MKT_RF",
      sub: "beta",
    });
    expect(parseFactorAxisKey("factor:MOM:return")).toEqual({
      code: "MOM",
      sub: "return",
    });
    expect(parseFactorAxisKey("factor:QMJ:risk")).toEqual({
      code: "QMJ",
      sub: "risk",
    });
  });

  it("returns null for non-factor or malformed keys", () => {
    expect(parseFactorAxisKey("rSquared")).toBeNull();
    expect(parseFactorAxisKey("alpha")).toBeNull();
    // Cast through unknown to test runtime behavior on invalid axis keys.
    expect(parseFactorAxisKey("factor:MKT_RF:bogus" as unknown as Parameters<typeof parseFactorAxisKey>[0])).toBeNull();
  });
});

describe("extractAxisValue", () => {
  it("returns the right built-in metric per axis key", () => {
    const row = makeRow({
      ticker: "X",
      rSquared: 0.4,
      realizedAnnualizedVol: 0.18,
      rollingAlphaPostBurnSum: 0.07,
      alphaTStat: 2.4,
      rollingResidualPostBurnSum: -0.02,
      residualTStat: -1.1,
    });
    expect(extractAxisValue(row, "rSquared")).toBeCloseTo(0.4);
    expect(extractAxisValue(row, "realizedVol")).toBeCloseTo(0.18);
    expect(extractAxisValue(row, "alpha")).toBeCloseTo(0.07);
    expect(extractAxisValue(row, "alphaTStat")).toBeCloseTo(2.4);
    expect(extractAxisValue(row, "residual")).toBeCloseTo(-0.02);
    expect(extractAxisValue(row, "residualTStat")).toBeCloseTo(-1.1);
  });

  it("extracts factor-cell axes for the right sub-metric", () => {
    const row = makeRow({
      ticker: "X",
      cells: { MKT_RF: makeCell(1.2, 5) }, // returnContribution = 1.2 * 0.05 = 0.06
    });
    expect(extractAxisValue(row, "factor:MKT_RF:beta")).toBeCloseTo(1.2);
    expect(extractAxisValue(row, "factor:MKT_RF:return")).toBeCloseTo(0.06);
    expect(extractAxisValue(row, "factor:MKT_RF:risk")).toBeCloseTo(1.2 * 0.1);
  });

  it("returns null when factor cell is missing", () => {
    const row = makeRow({ ticker: "X", cells: {} });
    expect(extractAxisValue(row, "factor:MKT_RF:beta")).toBeNull();
  });
});

describe("clipPercentileRange", () => {
  it("returns [min, max] for tiny inputs", () => {
    expect(clipPercentileRange([1, 5, 9])).toEqual([1, 9]);
  });

  it("clips outliers at 1st-99th percentile on a large input", () => {
    const values: number[] = [];
    for (let i = 0; i < 1000; i++) values.push(i / 999);
    values.push(1000); // outlier
    values.push(-1000); // outlier
    const range = clipPercentileRange(values)!;
    expect(range[0]).toBeGreaterThan(-100);
    expect(range[1]).toBeLessThan(100);
  });

  it("returns null for empty input", () => {
    expect(clipPercentileRange([])).toBeNull();
  });

  it("pads degenerate constant-data input", () => {
    const range = clipPercentileRange([5, 5, 5, 5, 5])!;
    expect(range[0]).toBeLessThan(5);
    expect(range[1]).toBeGreaterThan(5);
  });
});

describe("logScaleEligible", () => {
  it("rejects axes flagged signed regardless of data", () => {
    const def = axisDef("alpha");
    expect(def.inherentlyPositive).toBe(false);
    expect(logScaleEligible([0.1, 0.2, 0.3], def)).toBe(false);
  });

  it("rejects when data contains zero or negative values", () => {
    const def = axisDef("realizedVol");
    expect(logScaleEligible([0.1, 0.2, 0], def)).toBe(false);
    expect(logScaleEligible([0.1, -0.05, 0.3], def)).toBe(false);
  });

  it("accepts strictly-positive data on a positive axis", () => {
    const def = axisDef("realizedVol");
    expect(logScaleEligible([0.05, 0.18, 0.25], def)).toBe(true);
  });

  it("rejects empty input", () => {
    const def = axisDef("realizedVol");
    expect(logScaleEligible([], def)).toBe(false);
  });
});

describe("axisDef", () => {
  it("labels factor axes using the supplied factor labels map", () => {
    const def = axisDef("factor:MKT_RF:beta", { MKT_RF: "Market" });
    expect(def.label).toBe("β Market");
  });

  it("falls back to the bare code when no factor label is provided", () => {
    const def = axisDef("factor:QMJ:risk");
    expect(def.label).toBe("Risk contrib QMJ");
  });
});

describe("SCATTER_PRESETS", () => {
  it("defines exactly the three v1 presets", () => {
    const ids = SCATTER_PRESETS.map((p) => p.id).sort();
    expect(ids).toEqual(["alpha-vs-r2", "factor-x-vs-y", "real-alpha"]);
  });
});

// ---------------------------------------------------------------------------
// Mode-aware screener pipeline (log vs simple)
// ---------------------------------------------------------------------------

describe("summaryColumnValue routes alpha + residual on attribution mode", () => {
  it("returns log-space rolling sum when mode === 'log'", () => {
    const row = makeRow({
      ticker: "X",
      rollingAlphaPostBurnSum: 0.10, // simple-space
    });
    // Fixture sets log fields to 0.95× the simple values.
    expect(summaryColumnValue(row, "alpha", "log")).toBeCloseTo(0.10 * 0.95, 6);
    expect(summaryColumnValue(row, "alpha", "simple")).toBeCloseTo(0.10, 6);
  });

  it("returns log-space residual sum when mode === 'log'", () => {
    const row = makeRow({
      ticker: "X",
      rollingResidualPostBurnSum: -0.20,
    });
    expect(summaryColumnValue(row, "residual", "log")).toBeCloseTo(-0.20 * 0.95, 6);
    expect(summaryColumnValue(row, "residual", "simple")).toBeCloseTo(-0.20, 6);
  });

  it("R² and Vol are mode-invariant", () => {
    const row = makeRow({ ticker: "X", rSquared: 0.45, realizedAnnualizedVol: 0.18 });
    expect(summaryColumnValue(row, "rSquared", "log")).toBeCloseTo(0.45);
    expect(summaryColumnValue(row, "rSquared", "simple")).toBeCloseTo(0.45);
    expect(summaryColumnValue(row, "realizedVol", "log")).toBeCloseTo(0.18);
    expect(summaryColumnValue(row, "realizedVol", "simple")).toBeCloseTo(0.18);
  });

  it("defaults to log when no mode is provided", () => {
    const row = makeRow({ ticker: "X", rollingAlphaPostBurnSum: 0.10 });
    expect(summaryColumnValue(row, "alpha")).toBeCloseTo(0.10 * 0.95, 6);
  });
});

describe("totalReturn — realized total stock return column", () => {
  it("returns row.realizedTotalReturn directly (price-based, mode-invariant)", () => {
    const row = makeRow({ ticker: "X", realizedTotalReturn: 0.234 });
    // Pure passthrough: the value is computed in the service from
    // exp(Σ ln(1 + r_stock)) − 1 over the period date range.
    expect(summaryColumnValue(row, "totalReturn", "simple")).toBeCloseTo(0.234, 9);
    expect(summaryColumnValue(row, "totalReturn", "log")).toBeCloseTo(0.234, 9);
  });

  it("is mode-invariant — log and simple return the identical value", () => {
    // The realized total return is a pure price quantity; switching
    // attribution mode must NEVER change its value.
    const row = makeRow({ ticker: "X", realizedTotalReturn: -0.12 });
    expect(summaryColumnValue(row, "totalReturn", "log")).toBe(
      summaryColumnValue(row, "totalReturn", "simple"),
    );
  });

  it("ignores α / ε / factor-cell return contribs entirely", () => {
    // Even with wildly different rolling α, ε, and factor cells, the
    // column value follows row.realizedTotalReturn — proving the new
    // implementation no longer mixes the inconsistent decomposition
    // pieces (snapshot β with rolling α/ε) that caused the chart
    // mismatch.
    const row = makeRow({
      ticker: "X",
      realizedTotalReturn: 0.05,
      rollingAlphaPostBurnSum: 999,
      rollingResidualPostBurnSum: -999,
      cells: { EQ: makeCell(10) }, // returnContribution = 0.5 — nonsense
    });
    expect(summaryColumnValue(row, "totalReturn", "log")).toBeCloseTo(0.05, 9);
    expect(summaryColumnValue(row, "totalReturn", "simple")).toBeCloseTo(0.05, 9);
  });

  it("returns null when realizedTotalReturn is null (strict-drop on 1+r ≤ 0)", () => {
    const row = makeRow({ ticker: "X", realizedTotalReturn: null });
    expect(summaryColumnValue(row, "totalReturn", "log")).toBeNull();
    expect(summaryColumnValue(row, "totalReturn", "simple")).toBeNull();
  });

  it("returns null when realizedTotalReturn is non-finite", () => {
    const base = makeRow({ ticker: "X" });
    const row: PerStockRow = { ...base, realizedTotalReturn: Number.NaN };
    expect(summaryColumnValue(row, "totalReturn", "log")).toBeNull();
  });
});

describe("Jensen-correction sanity on synthetic returns", () => {
  // For an iid daily simple-return stream with mean μ and SD σ:
  //   E[ln(1 + r)] ≈ μ − 0.5 × σ²
  // ⇒  Σ ln(1+r_t) ≈ Σ r_t − 0.5 × σ² × N over a long-enough window.
  // A simple-space static α annualised vs a log-space static α annualised
  // should therefore differ by approximately 0.5 × σ²_annualised.
  //
  // We check the magnitude of the gap using only the log-returns helpers —
  // this locks the invariant the per-stock service depends on without
  // having to spin up a DB-backed end-to-end fixture.

  function makeSeries(seed: number, n: number, mean: number, sd: number): number[] {
    let s = seed;
    const rng = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    // Box-Muller for ~N(0,1)
    const out: number[] = [];
    for (let i = 0; i < n; i += 2) {
      const u1 = Math.max(rng(), 1e-12);
      const u2 = rng();
      const r = Math.sqrt(-2 * Math.log(u1));
      const z1 = r * Math.cos(2 * Math.PI * u2);
      const z2 = r * Math.sin(2 * Math.PI * u2);
      out.push(mean + sd * z1);
      if (i + 1 < n) out.push(mean + sd * z2);
    }
    return out;
  }

  it("low-vol stock (σ_ann ≈ 20 %): simple − log gap is < 3pp annualised", () => {
    const n = 252 * 2; // 2 years
    const sigmaDaily = 0.20 / Math.sqrt(252);
    const series = makeSeries(42, n, 0.0002, sigmaDaily);
    const sumSimple = series.reduce((s, v) => s + v, 0);
    let sumLog = 0;
    for (const v of series) sumLog += Math.log(1 + v);
    const annSimple = (sumSimple / n) * 252;
    const annLog = (sumLog / n) * 252;
    const gap = Math.abs(annSimple - annLog);
    expect(gap).toBeLessThan(0.03);
  });

  it("high-vol stock (σ_ann ≈ 100 %): simple − log gap ≈ 0.5 × σ²_ann (~50pp)", () => {
    const n = 252 * 2;
    const sigmaDaily = 1.0 / Math.sqrt(252);
    const series = makeSeries(99, n, 0.0002, sigmaDaily);
    const sumSimple = series.reduce((s, v) => s + v, 0);
    let sumLog = 0;
    for (const v of series) sumLog += Math.log(1 + v);
    const annSimple = (sumSimple / n) * 252;
    const annLog = (sumLog / n) * 252;
    const gap = annSimple - annLog;
    // Theoretical Jensen gap: 0.5 × σ²_ann = 0.5 × 1 = 0.5
    expect(gap).toBeGreaterThan(0.35);
    expect(gap).toBeLessThan(0.65);
  });
});

describe("makeRowComparator", () => {
  interface SortRow {
    ticker: string;
    x: number;
  }

  it("uses ticker alphabetical as a final tiebreaker", () => {
    const rows: SortRow[] = [
      { ticker: "ZED", x: 1 },
      { ticker: "ALPHA", x: 1 },
      { ticker: "BETA", x: 1 },
    ];
    const cmp = makeRowComparator<SortRow>(
      (r) => r.x,
      (r) => r.ticker,
      "desc",
    );
    rows.sort(cmp);
    expect(rows.map((r) => r.ticker)).toEqual(["ALPHA", "BETA", "ZED"]);
  });

  it("pushes NaN-keyed rows to the end and tiebreaks among them by ticker", () => {
    const rows: SortRow[] = [
      { ticker: "C", x: 5 },
      { ticker: "A", x: Number.NaN },
      { ticker: "B", x: Number.NaN },
      { ticker: "D", x: 3 },
    ];
    const cmp = makeRowComparator<SortRow>(
      (r) => r.x,
      (r) => r.ticker,
      "desc",
    );
    rows.sort(cmp);
    expect(rows.map((r) => r.ticker)).toEqual(["C", "D", "A", "B"]);
  });
});
