/** Shared formatters for Overview tab panels. */

const TRADING_DAYS = 252;

export function annualToDailyVol(annualVol: number): number {
  return annualVol / Math.sqrt(TRADING_DAYS);
}

/** Annualized vol decimal → "18.4%" (1 dp, unsigned). */
export function fmtVolAnn(annualVol: number): string {
  return `${(annualVol * 100).toFixed(1)}%`;
}

/** Daily vol decimal → "1.16%" (2 dp — smaller magnitudes). */
export function fmtVolDaily(dailyVol: number): string {
  return `${(dailyVol * 100).toFixed(2)}%`;
}

/** 1-day loss as % of notional — used for VaR/CVaR companion. */
export function fmtDailyLossPct(dollars: number, notional: number): string {
  if (!Number.isFinite(notional) || notional <= 0) return "—";
  return `${((dollars / notional) * 100).toFixed(2)}%`;
}

/** Raw decimal ×100, fixed width, no symbol — "18.40". */
export function fmtBbPct(decimal: number, decimals = 2): string {
  return (decimal * 100).toFixed(decimals);
}

/** Bloomberg daily vol — drops leading zero when < 1: ".78" not "0.78". */
export function fmtBbDailyVol(dailyDecimal: number): string {
  const pct = dailyDecimal * 100;
  const fixed = pct.toFixed(2);
  if (pct >= 0 && pct < 1 && fixed.startsWith("0.")) {
    return fixed.slice(1);
  }
  if (pct < 0 && pct > -1 && fixed.startsWith("-0.")) {
    return `-${fixed.slice(2)}`;
  }
  return fixed;
}

/** Compact unsigned dollars, no $ — "12.5k", "2.1M", "12450". */
export function fmtBbDollar(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}k`;
  return abs.toFixed(0);
}

/** VaR/CVaR daily loss % of notional, no % sign — "1.82" or "—". */
export function fmtBbLossPct(dollars: number, notional: number): string {
  if (!Number.isFinite(notional) || notional <= 0) return "—";
  return ((dollars / notional) * 100).toFixed(2);
}

/** Ann / Dly vol percent — 1 dp with %, e.g. "117.8%". */
export function fmtBbVolPct1d(decimal: number): string {
  return `${(decimal * 100).toFixed(1)}%`;
}

/** Per-share daily dollar move — 2 dp, e.g. "11.15" or "—". */
export function fmtBbShareVolDollar(price: number, dailyVol: number): string {
  if (!Number.isFinite(price) || price <= 0) return "—";
  return (price * dailyVol).toFixed(2);
}

/** Whole-dollar amounts — comma-separated, no $, no fractions, e.g. "1,500". */
export function fmtBbWholeDollar(n: number): string {
  return Math.round(Math.abs(n)).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
}

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

/** Gross portfolio weight decimal → "12.3%". */
export function fmtWeightPct(weight: number): string {
  if (!Number.isFinite(weight)) return "—";
  return `${(weight * 100).toFixed(1)}%`;
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
