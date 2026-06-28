/**
 * Engine 2 — display formatters for the FA (Financials) statement view.
 *
 * Statement / bridge dollars are scaled by the chosen unit and rendered with no
 * decimals and thousands separators (so the unit choice keeps every figure to at
 * most 6 integer digits). Per-share values stay in actual dollars (2 dp) and
 * margins / growth render as one-decimal percents.
 */
import type { FaUnit } from "./financials";

const SCALE: Record<FaUnit, number> = {
  thousands: 1e3,
  millions: 1e6,
  billions: 1e9,
};

const UNIT_LABEL: Record<FaUnit, string> = {
  thousands: "Thousands of USD",
  millions: "Millions of USD",
  billions: "Billions of USD",
};

export function unitLabel(unit: FaUnit): string {
  return UNIT_LABEL[unit];
}

/** Scaled statement / bridge dollar value: no decimals, comma-grouped, "—" if null. */
export function formatStatement(value: number | null | undefined, unit: FaUnit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const scaled = value / SCALE[unit];
  const rounded = Math.round(scaled);
  if (rounded === 0) return "0";
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Per-share value in actual dollars, 2 dp, "—" if null. */
export function formatPerShare(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Margin decimal -> "39.6%", 1 dp, "—" if null. */
export function formatMarginPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/** Growth decimal -> signed "+12.2%", 1 dp, "—" if null. */
export function formatGrowthPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

/** Multiple -> "12.3x", 1 dp + "x", "—" if null / non-finite. */
export function formatMultiple(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}x`;
}
