/** Shared formatters for Overview tab panels. */

export function fmt$(n: number) {
  const abs = Math.abs(n);
  const sign = n >= 0 ? "+" : "-";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
}

export function fmtPctSigned(n: number, decimals = 2) {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(decimals)}%`;
}

/** Unsigned compact dollar formatter, e.g. `$159k`, `$2.3M`. */
export function fmtCompact$(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(1)}k`;
  return `$${abs.toFixed(0)}`;
}

export function fmtPrice(n: number, decimals = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtShares(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export const POSITIVE_HEX = "#22c55e";
export const NEGATIVE_HEX = "#ef4444";

export function pnlColorize(n: number): "positive" | "negative" | "neutral" {
  if (n > 0) return "positive";
  if (n < 0) return "negative";
  return "neutral";
}
