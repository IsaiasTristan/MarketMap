import type { Horizon } from "@/domain/entities/horizons";

export const HORIZON_LABEL: Record<Horizon, string> = {
  D1: "1D",
  D5: "5D",
  M1: "1M",
  M3: "3M",
  M6: "6M",
  Y1: "1Y",
};

export function formatMetricValue(
  v: number | null,
  metric: "RETURN" | "EXCESS_RETURN" | "VOLATILITY" | "SHARPE"
): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (metric === "VOLATILITY" || metric === "RETURN" || metric === "EXCESS_RETURN") {
    return `${(v * 100).toFixed(2)}%`;
  }
  return v.toFixed(2);
}

// ── Shared chart / tile number formatting ────────────────────────────────────
// House rule: never show more than three significant digits on an axis or in a
// stat tile — pick the unit (K/M/B) so the mantissa stays ≤ 3 digits.

/** Nullish guard shared by the helpers below. */
function bad(v: number | null | undefined): v is null | undefined {
  return v == null || !Number.isFinite(v);
}

/**
 * Compact number with a unit suffix, no currency sign, ≤ 3 significant digits:
 * 460_000_000 → "460M", 1_200_000_000 → "1.2B", 8_500 → "8.5K", 250 → "250".
 * Sign is preserved. Carries at the unit boundary (999.5M → "1.0B").
 */
export function fmtAxisCompact(v: number | null | undefined): string {
  if (bad(v)) return "—";
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 999_500_000) return `${sign}${(a / 1e9).toFixed(1)}B`;
  if (a >= 999_500) {
    const m = a / 1e6;
    return `${sign}${m >= 100 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (a >= 1_000) {
    const k = a / 1e3;
    return `${sign}${k >= 100 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return `${sign}${a >= 100 ? a.toFixed(0) : a.toFixed(1)}`;
}

/** Compact dollars for axes/tooltips: "$460M" / "-$1.2B" / "$8.5K". */
export function fmtAxisDollar(v: number | null | undefined): string {
  if (bad(v)) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}$${fmtAxisCompact(Math.abs(v)).replace("-", "")}`;
}

/**
 * Whole-percent from a RATIO (0.27 → "27%", -3.729 → "-373%", 17.32 → "1,732%").
 * No decimals; thousands-separated. `clampAbs` caps magnitude (e.g. 1000).
 */
export function fmtPctWhole(
  ratio: number | null | undefined,
  clampAbs?: number
): string {
  if (bad(ratio)) return "—";
  let pct = ratio * 100;
  if (clampAbs != null && Math.abs(pct) > clampAbs) {
    pct = Math.sign(pct) * clampAbs;
  }
  return `${Math.round(pct).toLocaleString("en-US")}%`;
}

/**
 * Whole-percent from a value ALREADY in percent units (−454.3 → "-454%").
 * Used where the series is pre-multiplied by 100 (e.g. margin trajectory).
 */
export function fmtPctFromPct(
  pct: number | null | undefined,
  clampAbs?: number
): string {
  if (bad(pct)) return "—";
  let p = pct;
  if (clampAbs != null && Math.abs(p) > clampAbs) p = Math.sign(p) * clampAbs;
  return `${Math.round(p).toLocaleString("en-US")}%`;
}

/** Ratio rendered as a multiple: 2.03 → "2.0x", 0.12 → "0.1x". */
export function fmtMultiple(v: number | null | undefined): string {
  return bad(v) ? "—" : `${v.toFixed(1)}x`;
}

/**
 * Smart-unit money with ≤ 3 significant digits for stat tiles (TTM revenue etc):
 * 84_000_000 → "$84.0M", 2_100_000_000 → "$2.10B", 8_500 → "$8.50K".
 */
export function fmtSmartMoney(v: number | null | undefined): string {
  if (bad(v)) return "—";
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  const sig3 = (n: number) => (n >= 100 ? n.toFixed(1) : n >= 10 ? n.toFixed(2) : n.toFixed(2));
  if (a >= 1e9) return `${sign}$${sig3(a / 1e9)}B`;
  if (a >= 1e6) return `${sign}$${sig3(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}$${sig3(a / 1e3)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

/**
 * Pick a single unit for a whole axis from its max absolute value, so ticks read
 * "460" and the axis title can append the unit word. Returns the divisor to apply
 * to each tick value plus short ("M") and long ("millions") suffixes.
 */
export function axisUnit(maxAbs: number): {
  divisor: number;
  suffix: string;
  word: string;
} {
  const a = Math.abs(maxAbs);
  if (a >= 1e9) return { divisor: 1e9, suffix: "B", word: "billions" };
  if (a >= 1e6) return { divisor: 1e6, suffix: "M", word: "millions" };
  if (a >= 1e3) return { divisor: 1e3, suffix: "K", word: "thousands" };
  return { divisor: 1, suffix: "", word: "" };
}
