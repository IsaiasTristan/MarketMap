/**
 * Canonical factor definitions — single source of truth for labels,
 * descriptions, and tooltips shown in the UI.
 */
import type { FactorCode, FactorDef } from "@/types/factors";

export const FACTOR_DEFS: Record<FactorCode, FactorDef> = {
  MKT_RF: {
    code: "MKT_RF",
    label: "Market Beta",
    shortLabel: "Mkt β",
    description:
      "Sensitivity of the portfolio to broad market movements, measured as excess return of the market over the risk-free rate. A beta of 1.2 means the portfolio tends to move 1.2× the market.",
    whyItMatters:
      "The single largest driver of equity portfolio risk. High market beta amplifies both gains and losses in bull/bear cycles.",
    units: "beta",
    color: "var(--chart-1)",
  },
  SMB: {
    code: "SMB",
    label: "Size (SMB)",
    shortLabel: "Size",
    description:
      "Exposure to the small-minus-big factor. Positive loading means the portfolio behaves like small-cap stocks relative to large-caps.",
    whyItMatters:
      "Small-cap stocks have historically earned a size premium but carry higher liquidity risk and greater volatility in down markets.",
    units: "beta",
    color: "#22c55e",
  },
  HML: {
    code: "HML",
    label: "Value (HML)",
    shortLabel: "Value",
    description:
      "Exposure to the high-minus-low factor. Positive loading means the portfolio tilts toward high book-to-price (value) stocks over growth stocks.",
    whyItMatters:
      "Value stocks have historically outperformed over long horizons but can significantly underperform during growth rallies (e.g. 2017–2020).",
    units: "beta",
    color: "#f59e0b",
  },
  RMW: {
    code: "RMW",
    label: "Profitability (RMW)",
    shortLabel: "Profit",
    description:
      "Exposure to the robust-minus-weak profitability factor. Positive loading means the portfolio leans toward companies with strong operating profitability.",
    whyItMatters:
      "Profitability is a quality indicator. High-RMW portfolios tend to hold up better in downturns and deliver more consistent returns.",
    units: "beta",
    color: "var(--chart-4)",
  },
  CMA: {
    code: "CMA",
    label: "Investment (CMA)",
    shortLabel: "Invest",
    description:
      "Exposure to the conservative-minus-aggressive investment factor. Positive loading means the portfolio favors companies with conservative (low) asset growth.",
    whyItMatters:
      "Aggressive capital expenditure often signals overinvestment or value destruction. Low-investment firms tend to have better risk-adjusted returns.",
    units: "beta",
    color: "#e879f9",
  },
  MOM: {
    code: "MOM",
    label: "Momentum (MOM)",
    shortLabel: "Mom",
    description:
      "Exposure to the momentum factor (winners minus losers over the past 12 months, skipping the most recent month). Positive loading means the portfolio tilts toward recent outperformers.",
    whyItMatters:
      "Momentum is one of the most persistent return anomalies but is subject to sharp reversals ('momentum crashes') during market recoveries.",
    units: "beta",
    color: "#fb923c",
  },
  RF: {
    code: "RF",
    label: "Risk-Free Rate",
    shortLabel: "RF",
    description:
      "The daily risk-free rate (3-month T-bill annualized, divided by 252). Used to convert total returns to excess returns for regression.",
    whyItMatters:
      "Return above the risk-free rate represents the compensation investors receive for taking equity risk.",
    units: "pct",
    color: "#94a3b8",
  },
};

/** Ordered list of factor codes by their canonical display order. */
export const FACTOR_DISPLAY_ORDER: FactorCode[] = [
  "MKT_RF",
  "SMB",
  "HML",
  "RMW",
  "CMA",
  "MOM",
];

/** Look up a factor definition by code. */
export function getFactorDef(code: FactorCode): FactorDef {
  return FACTOR_DEFS[code] ?? {
    code,
    label: code,
    shortLabel: code,
    description: code,
    whyItMatters: "",
    units: "beta",
    color: "#94a3b8",
  };
}
