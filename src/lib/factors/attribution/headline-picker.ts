/**
 * Headline picker — pure helper that captures how the per-stock and portfolio
 * attribution panels resolve their "Total Excess Return" headline value.
 *
 * The display contract is:
 *   • Path B (log-return attribution) is the DEFAULT surface. When the server
 *     emits a non-null log series, the headline is driven by the compounded
 *     geometric reconciliation `exp(Σ y_log) − 1`. This number ties to
 *     realised performance over the visible window and matches what a user
 *     glances at the chart's right edge expecting to see.
 *   • Path A (arithmetic Σ y_simple) is a STRICT-DROP fallback used only when
 *     the log path is unavailable for the window (any daily simple return
 *     ≤ -100% kills the ln(1+r) domain). The fallback also triggers a banner
 *     in the UI so the user knows the displayed number is NOT a compounded
 *     total return.
 *
 * The helper is intentionally framework-agnostic and accepts only the small
 * pre-aggregated scalars it needs — the components compute Σy and Σy_log over
 * the visible / post-burn-in window themselves and feed them in. This keeps
 * the helper easy to test and prevents the display-layer policy from drifting
 * across panels.
 */
import { expSumMinus1 } from "./log-returns";

export interface HeadlinePickInput {
  /** Σ y_simple over the visible / post-burn-in window (always present). */
  arithmeticSum: number;
  /**
   * Σ y_log over the same window, or `null` when the log path was strict
   * dropped (any 1 + r_t ≤ 0 in the window). When `null` the helper signals
   * a fallback to Path A.
   */
  logSum: number | null;
}

export interface HeadlinePickResult {
  /** True when Path B drives the headline; false when falling back to A. */
  useLog: boolean;
  /**
   * Scalar to render in the big "Total Excess Return" number. In log mode
   * this is `exp(logSum) − 1`; in fallback mode it's `arithmeticSum`.
   */
  headlineValue: number;
  /** `exp(logSum) − 1` when log path is available, otherwise `null`. */
  geometric: number | null;
  /** Arithmetic Σ y_simple over the same window — always populated. */
  arithmetic: number;
  /** Σ y_log over the visible window, or `null` if the log path is missing. */
  logSum: number | null;
  /**
   * UI banner flag. `true` exactly when `useLog` is `false` because the log
   * path was strict-dropped — components show a yellow banner explaining
   * that the headline is not a compounded total in this case.
   */
  fallbackToSimple: boolean;
}

export function pickHeadlineValue(input: HeadlinePickInput): HeadlinePickResult {
  const useLog = input.logSum != null && Number.isFinite(input.logSum);
  if (useLog) {
    const geometric = expSumMinus1(input.logSum!);
    return {
      useLog: true,
      headlineValue: geometric,
      geometric,
      arithmetic: input.arithmeticSum,
      logSum: input.logSum,
      fallbackToSimple: false,
    };
  }
  return {
    useLog: false,
    headlineValue: input.arithmeticSum,
    geometric: null,
    arithmetic: input.arithmeticSum,
    logSum: null,
    fallbackToSimple: true,
  };
}
