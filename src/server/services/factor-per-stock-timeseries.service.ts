/**
 * factor-per-stock-timeseries.service — for a single ticker, runs rolling
 * multivariate OLS over the requested window and returns the full daily
 * decomposition time series:
 *
 *   y_t (excess return) = alpha_t + Σ_f β_t,f · X_t,f  + ε_t
 *
 * Each day t ≥ W − 1 uses coefficients from an OLS fit on the prior W
 * observations ending at t (inclusive). Days before t = W − 1 are the
 * "burn-in" period (no fit yet) and are surfaced via the `burnInIndex`
 * field. The chart visible region is `[displayStartIndex, n)` where
 * `displayStartIndex = max(burnInIndex, n - params.window)` — i.e. the
 * last `params.window` aligned days, but never before the burn-in
 * cutoff. With the 2026-04-26 extended-history loading, the visible
 * window is always fully populated with valid rolling fits so charts
 * render a full set of rolling β / risk / return points instead of a
 * thin cluster at the right edge.
 *
 * Phase 3 lock-ins (2026-04-25):
 *   • Q1 — rolling-Euler window length equals the snapshot regression
 *     window (`effectiveWindow = max(windowUsed, minObs)`), so the
 *     latest rolling Euler point ties exactly to the snapshot
 *     decomposition computed by `factor-per-stock.service`.
 *   • Q2 — burn-in is explicitly labelled (`burnInIndex = W − 1`); the
 *     chart's visible window starts at `displayStartIndex`. All identity
 *     sums consumed by the UI must skip `i < displayStartIndex` so totals
 *     match what the user actually sees.
 *   • Q3 — no silent degradation: rolling fits that fail (singular
 *     `(X'WX)⁻¹` even after ridge fallback) push the day's contributions
 *     to NaN/null and increment `rollingFitFailures` + push date to
 *     `rollingFitFailureDates[]`. The detail panel surfaces a banner.
 *   • Strict drop-row (Q3) — if a factor cell is missing for date d,
 *     the entire date is dropped from the aligned series and recorded in
 *     `droppedDates`. NEVER imputed as 0.
 *
 * Per-day Euler decomposition (rolling risk):
 *   For each t ≥ W − 1:
 *     • Σ_t  = factorCovarianceMatrix(rolling X window, ann.)
 *     • σ²_idio,t = Σ_{i ∈ window} ε_i² / dof   (annualised in decomposition)
 *     • Each factor's variance share = β_t,f × (Σ_t β_t)_f / total_variance_t
 *     • Idio share = σ²_idio,t / total_variance_t
 *     • Total vol  = √total_variance_t
 *
 * The rolling-window MSE used for the Euler decomposition uses residuals
 * from the rolling fit on its own window, mirroring how the snapshot
 * service computes σ²_idio.
 */
import { prisma as db } from "@/infrastructure/db/client";
import { rollingMultivariateOls } from "@/lib/factors/regression/rolling";
import { normalizeFactorRows } from "@/lib/factors/regression/normalization";
import { computeFactorCoverage } from "@/lib/factors/regression/coverage";
import { resolveModel, minObservations } from "@/lib/factors/definitions/model-presets";
import { getFactorDef, getFactorInputType } from "@/lib/factors/definitions/factor-codes";
import { factorCovarianceMatrix } from "@/lib/factors/risk/covariance";
import { computeRiskDecomposition } from "@/lib/factors/risk/decomposition";
import {
  factorRowLog,
  stockExcessLog,
  expSumMinus1,
} from "@/lib/factors/attribution/log-returns";
import { detectFactorStaleness } from "@/lib/factors/diagnostics/freshness";
import type { FactorCode, FactorStalenessEntry, ModelPresetName } from "@/types/factors";

const MIN_PRICE_HISTORY = 30;

/**
 * Minimum number of rolling fits required to produce a meaningful chart.
 * If `n < params.window + MIN_ROLLING_FITS - 1`, we shrink the rolling
 * window (sacrificing strict Q1 tie-out) so users still see a time series.
 * Surfaces the fallback in `windowFallback` so the UI / callers can warn.
 */
const MIN_ROLLING_FITS = 30;

/**
 * Extra trading days loaded beyond `params.window + rollingWindow` to absorb
 * minor calendar misalignment / strict drop-row losses so the visible
 * `params.window`-day chart starts on a valid rolling fit even when a
 * handful of historic dates get dropped (2026-04-26 lock-in).
 */
const DATA_BUFFER = 20;

/**
 * Trading days lost at the front of the loaded slice to the factor-vol
 * normalisation warm-up. `normalizeFactorRows` (called below with
 * `rollingWindow: 252, minObservations: 60`) cannot emit a normalised row
 * for the first `minObservations` days because there is no trailing window
 * to vol-scale against — those rows return null and are dropped.
 *
 * Without budgeting for this, the surviving post-normalisation slice is
 * `requiredHistory − NORM_WARMUP` and the rolling-OLS burn-in (which we
 * already budgeted for in `requiredHistory` directly) collapses onto the
 * visible window, eating ~40-90 days of decomposable observations.
 *
 * MUST equal the `minObservations` value passed to `normalizeFactorRows`
 * below — if you change one, change the other.
 */
const NORM_WARMUP = 60;

/**
 * Hard cap on the loaded date range so a user picking
 * Display W = 2520 + Rolling W = 2520 doesn't trigger an unbounded scan.
 * 5040 ≈ 20 trading years.
 */
const MAX_HISTORY = 5040;

export interface PerStockTimeseriesParams {
  ticker: string;
  model: ModelPresetName;
  /** Display range in trading days. */
  window: number;
  /** Rolling beta period in trading days (optional override). */
  rollingWindow?: number;
}

export interface PerStockTimeseriesResult {
  ticker: string;
  name: string;
  model: ModelPresetName;
  /**
   * Number of trading days in the loaded aligned series. With the
   * 2026-04-26 extended-history loading, this is typically larger than
   * `params.window` so the visible chart region (last `params.window` days)
   * is fully populated with valid rolling fits.
   */
  windowUsed: number;
  /** Length of the rolling regression window used for β + Euler. */
  rollingWindow: number;
  /**
   * Index of the first day to display on the chart (visible region is
   * `[displayStartIndex, n)`). Defined as
   *   `displayStartIndex = max(burnInIndex, n - params.window)`
   * so the visible window is always fully populated with valid rolling
   * fits whenever there is enough underlying history. Identity sums
   * consumed by the UI (waterfalls, header banners) skip
   * `i < displayStartIndex` so totals match the visible chart contents.
   */
  displayStartIndex: number;
  /**
   * Index `effectiveWindow - 1` — the first day for which a rolling fit
   * exists. UI uses this to grey-overlay the burn-in region IF it
   * overlaps the visible window (rare with extended history). Always
   * `<= displayStartIndex`.
   */
  burnInIndex: number;
  /** Aligned trading-day strings (YYYY-MM-DD), ascending. */
  dates: string[];
  /** Daily total excess return (decimal). */
  excessReturn: number[];
  /** Same as `excessReturn` — explicit name for scatter / API consumers. */
  actual: number[];
  /** Daily rolling intercept. NaN inside burn-in / on fit-failure days. */
  alpha: (number | null)[];
  /** Daily residual y - predicted. NaN inside burn-in / on fit-failure days. */
  residual: (number | null)[];
  /** Model-implied daily excess return (alpha + Σ β·X). NaN inside burn-in / on fit-failure days. */
  predicted: (number | null)[];
  /**
   * Daily per-factor return contribution = β_t,f × factor_return_t.
   * Keyed by factor code (FactorCode). NaN inside burn-in / on fit failure.
   */
  factorContrib: Record<string, (number | null)[]>;
  /** β at last observation (rolling window ending last day). */
  betas: Record<string, number>;
  /** One series per factor: rolling β_t,f aligned with `dates`. NaN in burn-in / on fit-failure. */
  rollingBetas: Record<string, (number | null)[]>;
  /**
   * Per-day Euler variance share per factor. Length = dates.length.
   * NaN inside burn-in / on fit-failure days. By Q1 lock-in, the value
   * at the last index ties to the snapshot per-stock service to ≤ 1 bp.
   */
  rollingPctVarianceContrib: Record<string, (number | null)[]>;
  /** Per-day idiosyncratic variance share. NaN in burn-in / on fit-failure. */
  rollingIdioShare: (number | null)[];
  /** Per-day annualised total volatility from the rolling Euler decomposition. NaN in burn-in. */
  rollingTotalVolAnn: (number | null)[];
  /** Factors actually used (subject to coverage check). */
  usableFactors: FactorCode[];
  /** Factor metadata for the UI. */
  factorMeta: { code: FactorCode; label: string; shortLabel: string; color: string }[];

  // ----- Telemetry (Phase 3 lock-ins) ------------------------------------
  /**
   * Number of rolling fits that failed (singular X'WX even after ridge
   * fallback). Should be 0 in normal cases — UI banners when > 0.
   */
  rollingFitFailures: number;
  /** Dates of rolling fit failures (post burn-in). */
  rollingFitFailureDates: string[];
  /**
   * Trading days dropped from the aligned series because of missing
   * factor data on that date. Strict drop-row (Q3 lock).
   */
  droppedDates: { date: string; factor: FactorCode }[];
  /**
   * Populated when the user-requested rolling window could not be honored
   * because the aligned sample is too short to leave room for at least
   * `MIN_ROLLING_FITS` rolling fits. In that case Q1 tie-out (rolling
   * window = snapshot window) is intentionally relaxed; the snapshot
   * itself is also running on `n` rather than `params.window` whenever
   * `n < params.window`, so the relaxation is consistent with what the
   * snapshot service is doing internally. UI callers should surface a
   * banner explaining the fallback.
   */
  windowFallback: {
    requestedWindow: number;
    effectiveWindow: number;
    availableObservations: number;
    reason:
      | "INSUFFICIENT_HISTORY" // n < params.window
      | "INSUFFICIENT_ROOM_FOR_ROLLING_FITS"; // n in [params.window, params.window+MIN_ROLLING_FITS-2]
  } | null;
  normalization: {
    config: { rollingWindow: number; minObservations: number; winsorSigma: number; targetAnnualVol: number | null };
    ambiguousFactors: FactorCode[];
    insufficientObservationsByFactor: Record<string, number>;
    totalRowsDroppedForNormalization: number;
  };
  /**
   * Factors whose latest published row trails the freshest day in the
   * loaded matrix by more than 3 trading days. Detected via
   * `detectFactorStaleness` (see `src/lib/factors/diagnostics/freshness.ts`).
   * Surfaced to the UI so users see a banner pointing them at
   * `POST /api/analysis/factors/pipeline-refresh` instead of silently
   * losing the most-recent decomposable days at the back of the window.
   * Empty array (not null) when all factors are fresh.
   */
  factorDataStale: FactorStalenessEntry[];

  // ---- Path B (log-return attribution) ----------------------------------
  /**
   * Parallel log-return rolling OLS results, computed when the per-day log
   * domain checks succeed for every aligned date. Length matches `dates`
   * with null entries inside burn-in / fit-failure / log-domain gaps so
   * the log identity `Σ y_log = Σ ŷ_log + Σ ε_log` holds across non-null
   * entries within `[displayStartIndex, n)`.
   *
   * Path B is intentionally computed on RAW factor log-returns
   * (`ln(1 + f_simple)`) — vol-scaled inputs from Path A would break the
   * additive log identity by mixing units.
   *
   * `null` here means the log path was unavailable (e.g. a single factor
   * produced `1 + f ≤ 0` on some date, which is rare in MACRO14 but the
   * service drops the entire log series in that case to keep Path A
   * unaffected).
   */
  log: PerStockLogTimeseries | null;
}

export interface PerStockLogTimeseries {
  /**
   * Daily excess log return: `ln(1 + r_stock) - ln(1 + r_f)`.
   * Length matches `dates`. Null on log-domain failures only (kept null
   * pointwise but set to null array if ANY date fails so the cumulative
   * identity stays exact).
   */
  excessLogReturn: number[];
  /** Daily intercept (log space). Null inside burn-in / on fit failure. */
  alphaLog: (number | null)[];
  /** Daily residual `y_log - ŷ_log`. Null inside burn-in / on fit failure. */
  residualLog: (number | null)[];
  /** Daily predicted log excess (`α + Σ β·x_log`). Null inside burn-in / on fit failure. */
  predictedLog: (number | null)[];
  /** Daily β·x_log per factor. Null inside burn-in / on fit failure. */
  factorLogContrib: Record<string, (number | null)[]>;
  /** β at last fit (log space). */
  betasLog: Record<string, number>;
  /** Rolling β series in log space. Null in burn-in / fit failure. */
  rollingBetasLog: Record<string, (number | null)[]>;
  /** Rolling-fit failure count for the log path. */
  rollingFitFailures: number;
  /** Sum of daily log excess from `displayStartIndex` to last index. */
  sumLogExcessVisible: number;
  /** Sum of decomposed log parts (alpha + factor contribs + residual) over the visible slice. */
  sumLogDecomposedVisible: number;
  /** `exp(sumLogExcessVisible) - 1`. Compounded geometric realised excess. */
  geometricExcessVisible: number;
  /**
   * `Σ ln(1 + r_stock_i)` over `[displayStartIndex, n)`. Computing
   * `exp(sumLogTotalVisible) − 1` recovers the compounded geometric
   * TOTAL (not excess) return — the figure broker / Google "1Y return"
   * displays. Identity: `sumLogTotalVisible = sumLogExcessVisible +
   * Σ ln(1 + r_f_i)`.
   *
   * Surfaced so the per-stock detail panel can show a "Total ≈ +X%"
   * sub-line under the excess headline without needing a per-day RF
   * array on the wire (2026-04-26 INTC reconciliation).
   */
  sumLogTotalVisible: number;
}

interface LoadedFactorMatrix {
  factorByDate: Map<string, Record<string, number>>;
  rfByDate: Map<string, number>;
  allDates: string[];
  perFactorByDate: Map<FactorCode, Map<string, number>>;
}

async function loadFactorMatrix(factorCodes: FactorCode[]): Promise<LoadedFactorMatrix> {
  const rows = await db.factorReturnDaily.findMany({
    where: { factorCode: { in: [...factorCodes, "RF"] } },
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true, factorCode: true, value: true },
  });

  const factorByDate = new Map<string, Record<string, number>>();
  const rfByDate = new Map<string, number>();
  const perFactorByDate = new Map<FactorCode, Map<string, number>>();
  const allDatesSet = new Set<string>();

  for (const row of rows) {
    const d = row.tradeDate.toISOString().slice(0, 10);
    allDatesSet.add(d);
    if (row.factorCode === "RF") {
      // Stored as daily simple decimal (KF native convention); no /252.
      rfByDate.set(d, Number(row.value));
      continue;
    }
    if (!factorByDate.has(d)) factorByDate.set(d, {});
    factorByDate.get(d)![row.factorCode] = Number(row.value);
    if (!perFactorByDate.has(row.factorCode as FactorCode)) {
      perFactorByDate.set(row.factorCode as FactorCode, new Map());
    }
    perFactorByDate.get(row.factorCode as FactorCode)!.set(d, Number(row.value));
  }

  return { factorByDate, rfByDate, allDates: [...allDatesSet].sort(), perFactorByDate };
}

export async function runPerStockTimeseries(
  params: PerStockTimeseriesParams,
): Promise<PerStockTimeseriesResult | null> {
  const preset = resolveModel(params.model);
  const requestedFactors = preset.factors as FactorCode[];

  const sec = await db.security.findFirst({
    where: { ticker: params.ticker.toUpperCase(), isActive: true },
    select: { id: true, ticker: true, name: true },
  });
  if (!sec) return null;

  const { factorByDate, rfByDate, allDates, perFactorByDate } = await loadFactorMatrix(
    requestedFactors,
  );
  if (allDates.length === 0) return null;

  // Stage 1 — coverage at the snapshot's `params.window` scope. This drives
  // `usableFactors`, which we LOCK so the timeseries decomposition uses the
  // same factor set as the snapshot service (preserves Q1 snapshot tie-out
  // even when we extend the loaded history below).
  const coverage = computeFactorCoverage({
    factorCodes: requestedFactors,
    dates: allDates,
    perFactorByDate,
    window: params.window,
  });
  const { usableFactors, alignedWindowDates } = coverage;
  // Compute freshness once on the full loaded matrix so the diagnostic is
  // independent of the per-window slicing below — a 60d view and a 1Y view
  // surface the same "factor X last published Feb 27" warning. RF is folded
  // in because the strict-drop loop downstream defaults missing RF to 0,
  // which silently inflates excess returns past the last RF print.
  const factorDataStale = detectFactorStaleness(factorByDate, usableFactors, {
    rfByDate,
  });
  if (usableFactors.length === 0 || alignedWindowDates.length < MIN_PRICE_HISTORY) {
    return null;
  }

  // Stage 2 — extend the loaded history to leave room for the rolling
  // burn-in. Without this, a Display W = 252 + Rolling W = 252 chart would
  // have only ~30 valid rolling fits clustered at the right edge (everything
  // else consumed by burn-in). With it, the visible `params.window` days
  // contain a full set of valid rolling observations.
  const requestedRollingHint = Math.max(20, params.rollingWindow ?? Math.min(60, params.window));
  const requiredHistory = Math.min(
    MAX_HISTORY,
    params.window + requestedRollingHint + NORM_WARMUP + DATA_BUFFER,
  );
  const extendedWindowDates = allDates.slice(-requiredHistory);

  const winStart = new Date(extendedWindowDates[0]!);
  const winEnd = new Date(extendedWindowDates[extendedWindowDates.length - 1]!);
  winStart.setUTCDate(winStart.getUTCDate() - 7);

  const priceRows = await db.priceHistory.findMany({
    where: { securityId: sec.id, tradeDate: { gte: winStart, lte: winEnd } },
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true, adjClose: true },
  });
  const priceMap = new Map<string, number>();
  for (const r of priceRows) priceMap.set(r.tradeDate.toISOString().slice(0, 10), Number(r.adjClose));

  if (priceMap.size < MIN_PRICE_HISTORY) return null;

  // STRICT DROP-ROW (Phase 3 Q3 lock): never zero-fill missing factor cells.
  //
  // Note (2026-04-26): `extendedWindowDates` is `allDates.slice(-N)` where
  // `allDates` is the union of every loaded factor's publish dates. That
  // union can include "phantom" dates the equity market was closed on
  // (e.g. AQR's BAB / QMJ publish on a global calendar that includes US
  // equity holidays; the FRED RF back-fill can also write rows on dates
  // outside the equity calendar). For those phantoms `priceMap.get(d)` is
  // undefined — the date is correctly skipped via the `cur == null` guard.
  // BUT the NEXT real trading day's `dPrev` would point at the phantom,
  // which has no priceMap entry, so prev would also be undefined and we'd
  // silently drop the next real trading day too. Fix: when `priceMap.get(
  // dPrev)` is undefined, fall back to the same backward date-arithmetic
  // search the i=0 case uses so the chain always finds the closest real
  // prior trading-day price within 7 calendar days. This makes the
  // strict-drop policy robust to any source of phantom rows in the factor
  // matrix without relaxing the policy itself.
  const aligned: { date: string; factorRow: number[]; excessReturn: number }[] = [];
  const droppedDates: { date: string; factor: FactorCode }[] = [];
  for (let i = 0; i < extendedWindowDates.length; i++) {
    const d = extendedWindowDates[i]!;
    const dPrev = i === 0 ? null : extendedWindowDates[i - 1]!;
    const cur = priceMap.get(d);
    let prev: number | undefined;
    if (dPrev != null) {
      prev = priceMap.get(dPrev);
    }
    if (prev === undefined) {
      const check = new Date(d);
      for (let lag = 1; lag <= 7 && prev === undefined; lag++) {
        check.setUTCDate(check.getUTCDate() - 1);
        prev = priceMap.get(check.toISOString().slice(0, 10));
      }
    }
    if (cur == null || prev == null || prev <= 0) continue;
    const r = (cur - prev) / prev;
    const excess = r - (rfByDate.get(d) ?? 0);

    const dayMap = factorByDate.get(d);
    if (!dayMap) {
      for (const code of usableFactors) droppedDates.push({ date: d, factor: code });
      continue;
    }
    const row: number[] = new Array(usableFactors.length);
    let dropRow = false;
    for (let fi = 0; fi < usableFactors.length; fi++) {
      const code = usableFactors[fi]!;
      const v = dayMap[code];
      if (v == null) {
        droppedDates.push({ date: d, factor: code });
        dropRow = true;
        break;
      }
      row[fi] = v;
    }
    if (dropRow) continue;
    aligned.push({ date: d, factorRow: row, excessReturn: excess });
  }

  const minObs = minObservations(usableFactors.length);
  if (aligned.length < minObs) return null;

  const datesRaw = aligned.map((a) => a.date);
  const yRaw = aligned.map((a) => a.excessReturn);
  const XRaw = aligned.map((a) => a.factorRow);
  const normResult = normalizeFactorRows(
    XRaw,
    usableFactors.map((code) => ({ code, inputType: getFactorInputType(code) })),
    {
      rollingWindow: 252,
      minObservations: 60,
      winsorSigma: 5,
      targetAnnualVol: 0.1,
    },
  );
  const dates: string[] = [];
  const y: number[] = [];
  const X: number[][] = [];
  const XRawKept: number[][] = [];
  for (let i = 0; i < datesRaw.length; i++) {
    const row = normResult.normalizedRows[i];
    if (!row || row.some((v) => v == null || !Number.isFinite(v))) continue;
    dates.push(datesRaw[i]!);
    y.push(yRaw[i]!);
    X.push(row as number[]);
    XRawKept.push(XRaw[i]!);
  }
  const n = dates.length;
  const k = usableFactors.length;
  if (n < minObs) return null;

  // Rolling window can be set independently from the display range
  // (`params.window`) via `params.rollingWindow`. This matches Bloomberg
  // behavior where chart rolling-beta period is distinct from range.
  //
  // We still enforce enough room for a meaningful series (>= MIN_ROLLING_FITS
  // points). With the extended-history loading above, the fallback is
  // rarely needed — only triggers when the underlying factor series is
  // genuinely too short to fit the requested rolling window.
  const requestedRolling = requestedRollingHint;
  const targetWindow = Math.max(requestedRolling, minObs);
  let effectiveWindow: number;
  let windowFallback: PerStockTimeseriesResult["windowFallback"] = null;

  if (n >= targetWindow + MIN_ROLLING_FITS - 1) {
    effectiveWindow = targetWindow;
  } else if (n >= targetWindow) {
    effectiveWindow = Math.max(minObs, n - MIN_ROLLING_FITS + 1);
    windowFallback = {
      requestedWindow: requestedRolling,
      effectiveWindow,
      availableObservations: n,
      reason: "INSUFFICIENT_ROOM_FOR_ROLLING_FITS",
    };
  } else {
    if (n < minObs + MIN_ROLLING_FITS - 1) return null;
    effectiveWindow = Math.max(minObs, n - MIN_ROLLING_FITS + 1);
    windowFallback = {
      requestedWindow: requestedRolling,
      effectiveWindow,
      availableObservations: n,
      reason: "INSUFFICIENT_HISTORY",
    };
  }
  if (n < effectiveWindow) return null;

  const rollingFits = rollingMultivariateOls(dates, y, X, effectiveWindow);
  if (rollingFits.length === 0) return null;

  const burnInIndex = effectiveWindow - 1;
  // Visible chart region is the LAST params.window days, but never before
  // the burn-in cutoff. With extended history loaded above, the visible
  // region is always fully-populated with valid rolling fits.
  const displayStartIndex = Math.max(burnInIndex, n - params.window);

  // Initialise output series (length n, NaN/null inside burn-in or on
  // fit-failure days per Q3 lock-in).
  const alpha: (number | null)[] = new Array(n).fill(null);
  const residual: (number | null)[] = new Array(n).fill(null);
  const predicted: (number | null)[] = new Array(n).fill(null);
  const rollingBetas: Record<string, (number | null)[]> = {};
  const factorContrib: Record<string, (number | null)[]> = {};
  const rollingPctVarianceContrib: Record<string, (number | null)[]> = {};
  const rollingIdioShare: (number | null)[] = new Array(n).fill(null);
  const rollingTotalVolAnn: (number | null)[] = new Array(n).fill(null);
  for (const code of usableFactors) {
    rollingBetas[code] = new Array(n).fill(null);
    factorContrib[code] = new Array(n).fill(null);
    rollingPctVarianceContrib[code] = new Array(n).fill(null);
  }

  let rollingFitFailures = 0;
  const rollingFitFailureDates: string[] = [];

  // Iterate rolling fits and compute per-day decomposition + per-day Euler.
  // Rolling fits start at index `burnInIndex` (one fit per day from
  // burn-in cutoff onward); the visible chart region is then a suffix
  // `[displayStartIndex, n)` of those days.
  for (let r = 0; r < rollingFits.length; r++) {
    const t = burnInIndex + r;
    const fit = rollingFits[r]!.fit;

    if (fit.failed) {
      rollingFitFailures++;
      rollingFitFailureDates.push(dates[t]!);
      continue; // leave NaN/null — do NOT silently zero
    }

    alpha[t] = fit.alpha;
    let predT = fit.alpha;
    for (let fi = 0; fi < k; fi++) {
      const code = usableFactors[fi]!;
      const b = fit.betas[fi] ?? 0;
      rollingBetas[code]![t] = b;
      const xNorm = X[t]?.[fi] ?? 0;
      const xRaw = XRawKept[t]?.[fi] ?? 0;
      factorContrib[code]![t] = b * xRaw;
      predT += b * xNorm;
    }
    predicted[t] = predT;
    residual[t] = (y[t] ?? 0) - predT;

    // Per-day Euler decomposition. Σ_t built from the rolling factor window
    // ending at t. σ²_idio,t built from the SAME window's residuals.
    const winStartIdx = t - effectiveWindow + 1;
    const factorSeriesCols = usableFactors.map((_, fi) =>
      X.slice(winStartIdx, t + 1).map((row) => row[fi]!),
    );
    const covMatrixT = factorCovarianceMatrix(factorSeriesCols, null, true);
    const dof = Math.max(1, fit.residuals.length - k - 1);
    const idioDailyVar =
      fit.residuals.reduce((s, e) => s + e ** 2, 0) / dof;

    const decompT = computeRiskDecomposition(
      fit.betas,
      covMatrixT,
      idioDailyVar,
      usableFactors,
      effectiveWindow,
    );
    rollingIdioShare[t] = decompT.idiosyncraticShare;
    rollingTotalVolAnn[t] = decompT.totalVolatility;
    for (let fi = 0; fi < k; fi++) {
      const code = usableFactors[fi]!;
      rollingPctVarianceContrib[code]![t] = decompT.factors[fi]?.pctVarianceContrib ?? 0;
    }
  }

  const betas: Record<string, number> = {};
  // Take the LAST non-null rolling β as the headline β (matches snapshot).
  for (const code of usableFactors) {
    let last = 0;
    const series = rollingBetas[code]!;
    for (let i = n - 1; i >= 0; i--) {
      const v = series[i];
      if (v != null && Number.isFinite(v)) {
        last = v;
        break;
      }
    }
    betas[code] = last;
  }

  const factorMeta = usableFactors.map((c) => {
    const def = getFactorDef(c);
    return { code: c, label: def.label, shortLabel: def.shortLabel, color: def.color };
  });

  // -----------------------------------------------------------------------
  // Path B — log-return rolling OLS (coexists with simple path above).
  // -----------------------------------------------------------------------
  // Reconstruct daily simple stock + RF returns to build log series:
  //   y_simple = r_stock - r_f  =>  r_stock = y_simple + r_f
  //   y_log = ln(1 + r_stock) - ln(1 + r_f)
  //   x_log_f = ln(1 + f_simple)
  //
  // Strict drop policy: if any date or factor produces a log-domain
  // failure (1 + r ≤ 0), Path B is suppressed entirely (returned as null).
  // In MACRO14 this should never trigger for ETF-derived factors; we keep
  // the soft fallback so Path A is never affected.
  let logBlock: PerStockLogTimeseries | null = null;
  let logValid = true;
  const yLog: number[] = new Array(n);
  const XLog: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const rfDaily = rfByDate.get(dates[i]!) ?? 0;
    const rStock = (y[i] ?? 0) + rfDaily;
    const yL = stockExcessLog(rStock, rfDaily);
    const xL = factorRowLog(XRawKept[i]!);
    if (yL == null || xL == null) {
      logValid = false;
      break;
    }
    yLog[i] = yL;
    XLog[i] = xL;
  }

  if (logValid && n >= effectiveWindow) {
    const rollingFitsLog = rollingMultivariateOls(dates, yLog, XLog, effectiveWindow);
    const alphaLog: (number | null)[] = new Array(n).fill(null);
    const residualLog: (number | null)[] = new Array(n).fill(null);
    const predictedLog: (number | null)[] = new Array(n).fill(null);
    const rollingBetasLog: Record<string, (number | null)[]> = {};
    const factorLogContrib: Record<string, (number | null)[]> = {};
    for (const code of usableFactors) {
      rollingBetasLog[code] = new Array(n).fill(null);
      factorLogContrib[code] = new Array(n).fill(null);
    }
    let logFitFailures = 0;
    for (let r = 0; r < rollingFitsLog.length; r++) {
      const t = burnInIndex + r;
      const fit = rollingFitsLog[r]!.fit;
      if (fit.failed) {
        logFitFailures++;
        continue;
      }
      alphaLog[t] = fit.alpha;
      let predT = fit.alpha;
      for (let fi = 0; fi < k; fi++) {
        const code = usableFactors[fi]!;
        const b = fit.betas[fi] ?? 0;
        rollingBetasLog[code]![t] = b;
        const xL = XLog[t]?.[fi] ?? 0;
        factorLogContrib[code]![t] = b * xL;
        predT += b * xL;
      }
      predictedLog[t] = predT;
      residualLog[t] = (yLog[t] ?? 0) - predT;
    }
    const betasLog: Record<string, number> = {};
    for (const code of usableFactors) {
      let last = 0;
      const series = rollingBetasLog[code]!;
      for (let i = n - 1; i >= 0; i--) {
        const v = series[i];
        if (v != null && Number.isFinite(v)) {
          last = v;
          break;
        }
      }
      betasLog[code] = last;
    }
    let sumLogExcessVisible = 0;
    let sumLogDecomposedVisible = 0;
    let sumLogTotalVisible = 0;
    let sumLogTotalValid = true;
    for (let i = displayStartIndex; i < n; i++) {
      const yL = yLog[i] ?? 0;
      sumLogExcessVisible += yL;
      const a = alphaLog[i];
      const e = residualLog[i];
      let parts = 0;
      if (a != null) parts += a;
      if (e != null) parts += e;
      for (const code of usableFactors) {
        const c = factorLogContrib[code]![i];
        if (c != null) parts += c;
      }
      sumLogDecomposedVisible += parts;

      // Total log return = excess log + ln(1 + r_f). Recover r_stock from
      // the excess + RF reconstruction we already used to build yLog above.
      // If 1 + r_stock ≤ 0 (extremely rare for a public equity), fall back
      // to leaving the total sum at 0 and surfacing it as identity-equal
      // to the excess sum (so the UI Total ≈ line just shows the excess).
      const rfDaily = rfByDate.get(dates[i]!) ?? 0;
      const rStock = (y[i] ?? 0) + rfDaily;
      if (1 + rStock <= 0) {
        sumLogTotalValid = false;
      } else {
        sumLogTotalVisible += Math.log(1 + rStock);
      }
    }
    logBlock = {
      excessLogReturn: yLog,
      alphaLog,
      residualLog,
      predictedLog,
      factorLogContrib,
      betasLog,
      rollingBetasLog,
      rollingFitFailures: logFitFailures,
      sumLogExcessVisible,
      sumLogDecomposedVisible,
      geometricExcessVisible: expSumMinus1(sumLogExcessVisible),
      sumLogTotalVisible: sumLogTotalValid ? sumLogTotalVisible : sumLogExcessVisible,
    };
  }

  return {
    ticker: sec.ticker,
    name: sec.name,
    model: params.model,
    windowUsed: n,
    rollingWindow: effectiveWindow,
    displayStartIndex,
    burnInIndex,
    dates,
    excessReturn: y,
    actual: y,
    alpha,
    residual,
    predicted,
    factorContrib,
    betas,
    rollingBetas,
    rollingPctVarianceContrib,
    rollingIdioShare,
    rollingTotalVolAnn,
    usableFactors,
    factorMeta,
    rollingFitFailures,
    rollingFitFailureDates,
    droppedDates,
    windowFallback,
    normalization: normResult.diagnostics,
    factorDataStale,
    log: logBlock,
  };
}
