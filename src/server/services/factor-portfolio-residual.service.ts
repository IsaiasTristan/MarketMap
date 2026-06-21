/**
 * factor-portfolio-residual.service — constructs the portfolio's "Unexplained"
 * residual time series ε_p,t = Σ_i w_i · ε_i,t directly from per-stock rolling
 * residuals (snapshot weights, fixed membership), and computes the four
 * scalars that feed the Total row's Unexplained cell across the STAT lens:
 *
 *   • residualSum            — Σε_p (cumulative; matches per-stock units)
 *   • residualTStat          — t-stat of mean(ε_p,t) using Newey-West (1994) HAC SE
 *   • residualCi95Half       — 95 % CI half-width on Σε_p (= 1.96 · n · HAC SE on mean)
 *   • residualAnnualizedVol  — σ(ε_p,t) · √252
 *
 * Methodology (locked-in 2026-05-03 with user):
 *   • Snapshot weights — today's signed portfolio weights projected
 *     backward through the window. Counterfactual but consistent with how
 *     the existing portfolio-level OLS already builds its X matrix. A
 *     historical-weights toggle is a follow-up; see TODO below.
 *   • Latest-burn-in alignment — start the constructed series at
 *     max_i(first valid rolling-residual date for stock i). Drop earlier
 *     dates rather than renormalising weights across a shifting holdings
 *     subset (which would make T-stats hard to interpret).
 *   • HAC SE on the mean (NOT naive sd/√n) — the rolling residuals share
 *     overlapping windows, so autocorrelation is non-trivial and OLS SE
 *     would understate. Bandwidth: Newey-West (1994) plug-in rule
 *     L = max(1, min(n-1, floor(4·(n/100)^(2/9)))).
 *   • Soft sanity warning — log when |mean|/σ > 0.5; that's a flag for
 *     either a bug in alignment or a genuinely pathological residual
 *     stream. Doesn't block the response.
 */

import { runPerStockFactors } from "./factor-per-stock.service";
import { loadPortfolioWeights } from "./portfolio.service";
import { neweyWestMeanSe } from "@/lib/factors/regression/hac";
import { prisma as db } from "@/infrastructure/db/client";
import type { ModelPresetName } from "@/types/factors";

const TRADING_DAYS = 252;

export interface PortfolioResidualStats {
  // ----- Simple-space ----------------------------------------------------
  /** Σε_p over the constructed series. Decimal cumulative (matches per-stock units). */
  residualSum: number;
  /** Mean of ε_p,t. Daily decimal — used for the T-stat numerator. */
  residualMean: number;
  /** t-stat of the mean using Newey-West (1994) HAC SE. */
  residualTStat: number;
  /** 95 % CI half-width on Σε_p: 1.96 · n · HAC SE(mean). */
  residualCi95Half: number;
  /** Annualised σ of the residual stream itself: σ(ε_p,t) · √252. */
  residualAnnualizedVol: number;

  // ----- Log-space (mode = "log") ---------------------------------------
  // Same shape but built from the log-space per-stock residual streams. Null
  // when no holdings expose a log stream (i.e. the log path failed for every
  // name — vanishingly rare).
  residualSumLog: number | null;
  residualMeanLog: number | null;
  residualTStatLog: number | null;
  residualCi95HalfLog: number | null;
  residualAnnualizedVolLog: number | null;

  /**
   * HAC + sample diagnostics. Surfaced verbatim into the Unexplained tooltip
   * so a sharp user can reproduce the computation.
   */
  diagnostics: {
    bandwidth: number;
    n: number;
    startDate: string;
    endDate: string;
    /**
     * Names dropped from the constructed series because their rolling-OLS
     * couldn't fit (insufficient history, normalisation cuts, etc.). When
     * non-empty, the residual is computed on the SUBSET of holdings whose
     * weights are renormalised among themselves — flagged in the UI so the
     * user knows the number isn't covering the whole portfolio.
     */
    droppedHoldings: string[];
    /** Σ |signedWeight_i| of the names that contributed to the series. */
    coverageWeight: number;
    /** True iff |mean|/σ > 0.5 — printed as a warning in server logs. */
    saneAssertionFailed: boolean;
    /** HAC bandwidth on the log-space series (typically ≈ simple bandwidth). */
    bandwidthLog: number | null;
    /** Number of dates in the log-space series (typically ≈ simple n). */
    nLog: number | null;
  };
}

interface PortfolioResidualParams {
  portfolioId: string;
  model: ModelPresetName;
  window: number;
}

/**
 * Build the portfolio residual stats. Returns null when the data set is too
 * sparse to construct a meaningful series (no holdings, no overlapping
 * post-burn-in dates, or every name's residual stream is missing).
 */
export async function computePortfolioResidualStats(
  params: PortfolioResidualParams,
): Promise<PortfolioResidualStats | null> {
  const holdings = await loadPortfolioWeights(db, params.portfolioId);
  if (holdings.length === 0) return null;

  const heldTickers = holdings.map((h) => h.ticker.toUpperCase());

  // Reuse the per-stock pipeline — same factor matrix, same coverage rules,
  // same rolling-OLS — but restricted to the held names and asked to retain
  // the residual streams.
  // TODO(historical-weights): when position history is available, swap the
  // snapshot-weight construction below for a per-date weight lookup.
  const perStock = await runPerStockFactors({
    model: params.model,
    window: params.window,
    tickerSubset: heldTickers,
    retainResidualStreams: true,
  });
  if (!perStock || perStock.rows.length === 0) return null;

  // Index per-ticker residual streams (both simple- and log-space). Holdings
  // are usable for the simple roll-up if they have a simple stream; usable
  // for the log roll-up if they have BOTH a simple stream (for membership)
  // AND a log stream. Membership of the simple set is what determines
  // droppedHoldings — the log set is a (usually full) subset.
  const streamByTicker = new Map<string, { dates: string[]; residuals: number[] }>();
  const streamLogByTicker = new Map<
    string,
    { dates: string[]; residuals: number[] }
  >();
  for (const row of perStock.rows) {
    if (row.rollingResidualStream && row.rollingResidualStream.dates.length > 0) {
      streamByTicker.set(row.ticker.toUpperCase(), row.rollingResidualStream);
    }
    if (
      row.rollingResidualStreamLog &&
      row.rollingResidualStreamLog.dates.length > 0
    ) {
      streamLogByTicker.set(row.ticker.toUpperCase(), row.rollingResidualStreamLog);
    }
  }

  // Drop holdings without a usable residual stream from the construction;
  // surface the names so the UI can warn that the residual is on a
  // subset.
  const usableHoldings = holdings.filter((h) =>
    streamByTicker.has(h.ticker.toUpperCase()),
  );
  const droppedHoldings = holdings
    .filter((h) => !streamByTicker.has(h.ticker.toUpperCase()))
    .map((h) => h.ticker);

  if (usableHoldings.length === 0) return null;

  // Latest-burn-in alignment: start at max_i(first residual date_i). Names
  // whose first residual date is later than the latest end_i are unusable;
  // the loop below drops them silently.
  const latestStart = usableHoldings
    .map((h) => streamByTicker.get(h.ticker.toUpperCase())!.dates[0]!)
    .reduce((a, b) => (a > b ? a : b));
  const earliestEnd = usableHoldings
    .map((h) => {
      const s = streamByTicker.get(h.ticker.toUpperCase())!;
      return s.dates[s.dates.length - 1]!;
    })
    .reduce((a, b) => (a < b ? a : b));
  if (latestStart > earliestEnd) return null;

  // Build a date → residual lookup per stock for fast membership checks.
  const lookup = new Map<string, Map<string, number>>();
  for (const h of usableHoldings) {
    const s = streamByTicker.get(h.ticker.toUpperCase())!;
    const m = new Map<string, number>();
    for (let i = 0; i < s.dates.length; i++) m.set(s.dates[i]!, s.residuals[i]!);
    lookup.set(h.ticker.toUpperCase(), m);
  }

  // Build the union of dates spanning [latestStart, earliestEnd] from any
  // stream — they're all daily so they should agree, but using the union
  // is robust to one stream being missing a non-trading day flag.
  const dateSet = new Set<string>();
  for (const h of usableHoldings) {
    const s = streamByTicker.get(h.ticker.toUpperCase())!;
    for (const d of s.dates) {
      if (d >= latestStart && d <= earliestEnd) dateSet.add(d);
    }
  }
  const constructionDates = [...dateSet].sort();

  // Snapshot weights for the residual aggregation. Renormalise across the
  // usable subset so the sum of |w| equals what the user holds in liquid
  // factor coverage. Sign is preserved for shorts.
  const totalSignedAbs = usableHoldings.reduce((s, h) => s + Math.abs(h.signedWeight), 0);
  const totalAllAbs = holdings.reduce((s, h) => s + Math.abs(h.signedWeight), 0);
  const coverageWeight = totalAllAbs > 0 ? totalSignedAbs / totalAllAbs : 0;
  const weightByTicker = new Map<string, number>();
  for (const h of usableHoldings) {
    // Renormalise so usable subset's |w| sums to 1.
    const wRenorm = totalSignedAbs > 0 ? h.signedWeight / totalSignedAbs : 0;
    weightByTicker.set(h.ticker.toUpperCase(), wRenorm);
  }

  // Build simple-space residual series in the same loop as before.
  const residualSeries: number[] = [];
  for (const d of constructionDates) {
    let eps = 0;
    let allPresent = true;
    for (const h of usableHoldings) {
      const tk = h.ticker.toUpperCase();
      const v = lookup.get(tk)!.get(d);
      if (v == null) {
        allPresent = false;
        break;
      }
      eps += (weightByTicker.get(tk) ?? 0) * v;
    }
    // Strict drop-row: skip dates where any name's residual is missing
    // (preserves "fixed membership" — never silently drop a stock for one
    // day and renormalise the others).
    if (!allPresent) continue;
    residualSeries.push(eps);
  }

  if (residualSeries.length < 2) return null;

  const hac = neweyWestMeanSe(residualSeries);
  const n = hac.n;
  const sum = residualSeries.reduce((s, v) => s + v, 0);
  // CI half on Σε: 1.96 × n × SE_HAC(mean) — same scale as the displayed
  // Σε. T-stat is identical whether computed on Σε or mean (n cancels).
  const ciHalfOnSum = hac.hacSe > 0 ? 1.96 * n * hac.hacSe : 0;
  const tStat = hac.hacSe > 0 ? hac.mean / hac.hacSe : 0;

  // Annualised σ of the residual stream itself.
  const seriesMean = hac.mean;
  const seriesVar =
    residualSeries.reduce((s, v) => s + (v - seriesMean) ** 2, 0) / Math.max(1, n - 1);
  const annualizedVol = Math.sqrt(Math.max(seriesVar, 0) * TRADING_DAYS);

  // Soft sanity assertion — flag pathological alignment or a real signal.
  const seriesSd = Math.sqrt(Math.max(seriesVar, 0));
  const saneAssertionFailed =
    seriesSd > 0 && Math.abs(seriesMean) / seriesSd > 0.5;
  if (saneAssertionFailed) {
    // eslint-disable-next-line no-console
    console.warn(
      `[factor-portfolio-residual] |mean|/σ = ${(Math.abs(seriesMean) / seriesSd).toFixed(2)} for portfolio ${params.portfolioId} (${params.model}/${params.window}d). Residual stream may be misaligned or genuinely drifting.`,
    );
  }

  // ---------------------------------------------------------------------
  // Log-space residual series — built in the same membership/date frame
  // as the simple-space series so the Total row's Unexplained cell can
  // route between the two without a re-roll. Strict drop-row preserved:
  // skip dates where any contributing name's log residual is missing.
  // ---------------------------------------------------------------------
  let residualSumLog: number | null = null;
  let residualMeanLog: number | null = null;
  let residualTStatLog: number | null = null;
  let residualCi95HalfLog: number | null = null;
  let residualAnnualizedVolLog: number | null = null;
  let bandwidthLog: number | null = null;
  let nLog: number | null = null;

  // Log-space stream lookups. If any usable holding lacks a log stream we
  // can't construct a meaningful aggregate (membership would diverge from
  // the simple-space side); we leave the log fields null in that case.
  const allHaveLog = usableHoldings.every((h) =>
    streamLogByTicker.has(h.ticker.toUpperCase()),
  );
  if (allHaveLog) {
    const lookupLog = new Map<string, Map<string, number>>();
    for (const h of usableHoldings) {
      const s = streamLogByTicker.get(h.ticker.toUpperCase())!;
      const m = new Map<string, number>();
      for (let i = 0; i < s.dates.length; i++) m.set(s.dates[i]!, s.residuals[i]!);
      lookupLog.set(h.ticker.toUpperCase(), m);
    }
    const residualSeriesLog: number[] = [];
    for (const d of constructionDates) {
      let eps = 0;
      let allPresent = true;
      for (const h of usableHoldings) {
        const tk = h.ticker.toUpperCase();
        const v = lookupLog.get(tk)!.get(d);
        if (v == null) {
          allPresent = false;
          break;
        }
        eps += (weightByTicker.get(tk) ?? 0) * v;
      }
      if (!allPresent) continue;
      residualSeriesLog.push(eps);
    }
    if (residualSeriesLog.length >= 2) {
      const hacLog = neweyWestMeanSe(residualSeriesLog);
      const sumLog = residualSeriesLog.reduce((s, v) => s + v, 0);
      const ciHalfOnSumLog = hacLog.hacSe > 0 ? 1.96 * hacLog.n * hacLog.hacSe : 0;
      const tStatLog = hacLog.hacSe > 0 ? hacLog.mean / hacLog.hacSe : 0;
      const meanLog = hacLog.mean;
      const varLog =
        residualSeriesLog.reduce((s, v) => s + (v - meanLog) ** 2, 0) /
        Math.max(1, hacLog.n - 1);
      residualSumLog = sumLog;
      residualMeanLog = meanLog;
      residualTStatLog = tStatLog;
      residualCi95HalfLog = ciHalfOnSumLog;
      residualAnnualizedVolLog = Math.sqrt(Math.max(varLog, 0) * TRADING_DAYS);
      bandwidthLog = hacLog.bandwidth;
      nLog = hacLog.n;
    }
  }

  return {
    residualSum: sum,
    residualMean: seriesMean,
    residualTStat: tStat,
    residualCi95Half: ciHalfOnSum,
    residualAnnualizedVol: annualizedVol,
    residualSumLog,
    residualMeanLog,
    residualTStatLog,
    residualCi95HalfLog,
    residualAnnualizedVolLog,
    diagnostics: {
      bandwidth: hac.bandwidth,
      n,
      startDate: constructionDates[0]!,
      endDate: constructionDates[constructionDates.length - 1]!,
      droppedHoldings,
      coverageWeight,
      saneAssertionFailed,
      bandwidthLog,
      nLog,
    },
  };
}
