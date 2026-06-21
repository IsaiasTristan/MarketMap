/**
 * Scatter axis extractors + outlier-clip helpers for the per-stock factor
 * scatter panel (Phase B of UI additions).
 *
 * Axis keys are namespaced strings so they round-trip cleanly through URL
 * params, store persistence, and React state without needing a custom
 * encoder. Built-in axes (R², Vol, α, α t-stat, ε, ε t-stat) live in their
 * own namespace; per-factor axes live under `factor:CODE:beta` /
 * `factor:CODE:return` / `factor:CODE:risk`.
 *
 * Locked rules:
 *   • Default zoom clips to the 1st-99th percentile of the data along each
 *     axis. Outliers stay rendered (they're not removed from the dataset),
 *     but the chart's visible range doesn't get squashed by them.
 *   • Log-scale is only sensible when every value on that axis is positive.
 *     Mixed-sign axes (α, factor return contribution, residual) disable
 *     log-scale at render time.
 */
import type { FactorCode } from "@/types/factors";
import type { PerStockRow } from "@/server/services/factor-per-stock.service";

/**
 * Axis key — string union encoded as namespaced literals so it survives
 * persistence cleanly. `factor:CODE:beta` etc. parsed at render time.
 */
export type ScatterAxisKey =
  | "rSquared"
  | "realizedVol"
  | "alpha"
  | "alphaTStat"
  | "residual"
  | "residualTStat"
  | `factor:${FactorCode}:${"beta" | "return" | "risk"}`;

export interface ScatterAxisDef {
  key: ScatterAxisKey;
  /** UI label (short). */
  label: string;
  /** Longer description used in tooltips / dropdown subtitles. */
  description: string;
  /**
   * Whether the metric is bounded below at 0 (R², Vol, |t|-style). Used
   * to gate log-scale eligibility before the data check.
   */
  inherentlyPositive: boolean;
  /** Format hint: "decimal", "percent", "tStat" (no unit). */
  format: "decimal" | "percent" | "tStat";
}

const BUILTIN_DEFS: Record<
  Exclude<ScatterAxisKey, `factor:${string}`>,
  Omit<ScatterAxisDef, "key">
> = {
  rSquared: {
    label: "R²",
    description: "Snapshot OLS R² — fit quality of the factor model on this stock",
    inherentlyPositive: true,
    format: "percent",
  },
  realizedVol: {
    label: "Realised vol",
    description: "Annualised σ of the stock's excess return",
    inherentlyPositive: true,
    format: "percent",
  },
  alpha: {
    label: "Alpha (Σα)",
    description: "Σ rolling α_t over post burn-in — annualisation already in raw daily sum",
    inherentlyPositive: false,
    format: "percent",
  },
  alphaTStat: {
    label: "Alpha t-stat",
    description: "α / SE(α) from the snapshot OLS — > 2 is statistically distinct from zero",
    inherentlyPositive: false,
    format: "tStat",
  },
  residual: {
    label: "Unexplained (Σε)",
    description: "Σ rolling residual — drift the factor model could not explain",
    inherentlyPositive: false,
    format: "percent",
  },
  residualTStat: {
    label: "Unexplained t-stat",
    description: "Σε / (σ_ε × √n) — is the unexplained drift statistically distinct from zero?",
    inherentlyPositive: false,
    format: "tStat",
  },
};

/** Parse a `factor:CODE:beta|return|risk` axis key into its parts. */
export function parseFactorAxisKey(
  key: ScatterAxisKey,
): { code: FactorCode; sub: "beta" | "return" | "risk" } | null {
  if (!key.startsWith("factor:")) return null;
  const parts = key.split(":");
  if (parts.length !== 3) return null;
  const code = parts[1] as FactorCode;
  const sub = parts[2] as "beta" | "return" | "risk";
  if (sub !== "beta" && sub !== "return" && sub !== "risk") return null;
  return { code, sub };
}

export function axisDef(key: ScatterAxisKey, factorLabels: Record<string, string> = {}): ScatterAxisDef {
  const factor = parseFactorAxisKey(key);
  if (factor) {
    const label = factorLabels[factor.code] ?? factor.code;
    if (factor.sub === "beta") {
      return {
        key,
        label: `β ${label}`,
        description: `OLS beta of ${factor.code}`,
        inherentlyPositive: false,
        format: "decimal",
      };
    }
    if (factor.sub === "return") {
      return {
        key,
        label: `Return contrib ${label}`,
        description: `β × Σ r_t for ${factor.code} (additive)`,
        inherentlyPositive: false,
        format: "percent",
      };
    }
    return {
      key,
      label: `Risk contrib ${label}`,
      description: `Euler PCR of ${factor.code} on this stock`,
      inherentlyPositive: false,
      format: "percent",
    };
  }
  const def = BUILTIN_DEFS[key as Exclude<ScatterAxisKey, `factor:${string}`>];
  return { key, ...def };
}

/**
 * Extract the value of a scatter axis for a given row. Returns null when
 * the row has no value for that axis (e.g., a factor cell missing for
 * this stock). Non-finite values also return null so the scatter doesn't
 * have to defend against NaN downstream.
 */
export function extractAxisValue(
  row: PerStockRow,
  key: ScatterAxisKey,
): number | null {
  const factor = parseFactorAxisKey(key);
  if (factor) {
    const cell = row.cells[factor.code];
    if (!cell) return null;
    const v =
      factor.sub === "beta"
        ? cell.beta
        : factor.sub === "return"
          ? cell.returnContribution
          : cell.riskContribution;
    return Number.isFinite(v) ? v : null;
  }
  let v: number | null;
  switch (key) {
    case "rSquared":
      v = row.rSquared;
      break;
    case "realizedVol":
      v = row.realizedAnnualizedVol;
      break;
    case "alpha":
      v = row.rollingAlphaPostBurnSum;
      break;
    case "alphaTStat":
      v = row.alphaTStat;
      break;
    case "residual":
      v = row.rollingResidualPostBurnSum;
      break;
    case "residualTStat":
      v = row.residualTStat;
      break;
    default:
      v = null;
  }
  if (v == null || !Number.isFinite(v)) return null;
  return v;
}

/**
 * Compute a clipped axis range using the 1st-99th percentile of the data.
 * Returns `[min, max]`. When no values are available, returns null and
 * the chart should default to autoscaling.
 *
 * The full data still renders — outliers fall outside the clip range and
 * are clamped to the chart edge by the caller's logScale / coordinate
 * mapping. We don't drop them from the dataset.
 */
export function clipPercentileRange(
  values: ReadonlyArray<number>,
): [number, number] | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 4) {
    // Too few to meaningfully percentile-clip — return [min, max] as-is.
    return [sorted[0]!, sorted[sorted.length - 1]!];
  }
  const lo = sorted[Math.floor(0.01 * (sorted.length - 1))]!;
  const hi = sorted[Math.ceil(0.99 * (sorted.length - 1))]!;
  if (lo === hi) {
    // Degenerate: pad slightly so the chart has a visible range.
    return [lo - 1, hi + 1];
  }
  return [lo, hi];
}

/**
 * Decide whether log-scale is sensible for an axis given the data: every
 * extracted value must be > 0 and the axis must not be inherently signed.
 * Caller passes already-extracted values so we don't re-walk rows.
 */
export function logScaleEligible(
  values: ReadonlyArray<number>,
  axis: ScatterAxisDef,
): boolean {
  if (!axis.inherentlyPositive) return false;
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0) return false;
  }
  return values.length > 0;
}

/** Format an axis tick value for display under the axis. */
export function formatAxisValue(
  v: number,
  format: ScatterAxisDef["format"],
): string {
  if (!Number.isFinite(v)) return "—";
  if (format === "percent") return `${(v * 100).toFixed(1)}%`;
  if (format === "tStat") return v.toFixed(1);
  return v.toFixed(2);
}

/**
 * Three preset axis combos that ship with v1. The two presets requiring
 * server-side columns we haven't built yet (vol-adjusted alpha, β stability)
 * are intentionally absent — they'll appear once their columns land.
 */
export const SCATTER_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  x: ScatterAxisKey;
  y: ScatterAxisKey;
}> = [
  {
    id: "real-alpha",
    label: "Real α",
    description: "Alpha t-stat × Σα — top-right is real alpha; top-left is noisy",
    x: "alphaTStat",
    y: "alpha",
  },
  {
    id: "alpha-vs-r2",
    label: "α vs R²",
    description: "R² × Σα — top-left is genuine residual; top-right is explained-away",
    x: "rSquared",
    y: "alpha",
  },
  {
    id: "factor-x-vs-y",
    label: "Factor β-X vs β-Y",
    description: "Two-factor exposure landscape — pick the X and Y factors via the dropdowns",
    // Default: market vs momentum. The dropdowns are still live; the
    // preset just picks sensible starting axes.
    x: "factor:MKT_RF:beta",
    y: "factor:MOM:beta",
  },
];
