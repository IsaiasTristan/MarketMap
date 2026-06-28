/**
 * Engine 2 — multi-box discovery registry. The single source of truth for which
 * boxes exist, their components, labels, and orientation. Both the scoring loop
 * (two-level peer z-score) and the grid UI read this registry, so adding a box
 * or component is a one-place change. Pure metadata — no I/O.
 *
 * Component values are produced (already oriented HIGHER = BETTER) by the
 * per-box pure libs; the flat key used in the scoring map and the audited
 * scoreJson is `${boxKey}.${componentKey}`.
 */
import { SURPRISE_COMPONENT_KEYS } from "./surprise";
import { RESIDUAL_MOMENTUM_COMPONENT_KEYS } from "./residual-momentum";
import { CASH_QUALITY_COMPONENT_KEYS } from "./cash-quality";
import { PERSISTENCE_COMPONENT_KEYS } from "./persistence";
import { BALANCE_SHEET_COMPONENT_KEYS } from "./balance-sheet";
import { VALUATION_BOX_COMPONENT_KEYS } from "./valuation-box";
import { FORECAST_CONFIDENCE_COMPONENT_KEYS } from "./forecast-confidence";
import { DILUTION_COMPONENT_KEYS } from "./dilution";
import { INFLECTION_SIGNALS } from "./inflection";

/** Calculation-version identifier — bump when the methodology changes. */
export const SCORE_METHODOLOGY_VERSION = "discovery_9_box_v1.0";

/** Composite requires at least this many valid boxes (user-confirmed scope). */
export const MIN_VALID_BOXES = 8;

export type BoxKey =
  | "inflection"
  | "surprise"
  | "residualMomentum"
  | "cashQuality"
  | "persistence"
  | "balanceSheet"
  | "valuation"
  | "forecastConfidence"
  | "dilution";

export interface BoxComponentDef {
  /** Bare component key (matches the per-box lib output object key). */
  key: string;
  label: string;
}

export interface BoxDef {
  key: BoxKey;
  /** Full label for tooltips / diligence. */
  label: string;
  /** Compact column header for the grid. */
  shortLabel: string;
  components: BoxComponentDef[];
  description: string;
}

function defs(
  keys: readonly string[],
  labels: Record<string, string>,
): BoxComponentDef[] {
  return keys.map((key) => ({ key, label: labels[key] ?? key }));
}

export const BOX_REGISTRY: BoxDef[] = [
  {
    key: "inflection",
    label: "Inflection Signals",
    shortLabel: "Inflection",
    description:
      "Business-level inflection: recent-vs-prior slope of margins / growth / ROIC / leverage (z within peers).",
    components: defs(INFLECTION_SIGNALS as readonly string[], {
      grossMarginInflection: "Gross Margin",
      ebitdaMarginInflection: "EBITDA Margin",
      revenueGrowthAccel: "Revenue Growth",
      fcfInflection: "FCF",
      roicTrend: "ROIC",
      deleveraging: "Δ Net Debt",
    }),
  },
  {
    key: "surprise",
    label: "Earnings & Revenue Surprise",
    shortLabel: "Surprise",
    description: "Reported EPS / revenue vs the consensus immediately before the report.",
    components: defs(SURPRISE_COMPONENT_KEYS, {
      latestEpsSurprise: "Latest EPS surprise",
      latestRevenueSurprise: "Latest revenue surprise",
      avg4EpsSurprise: "4Q avg EPS surprise",
      avg4RevenueSurprise: "4Q avg revenue surprise",
    }),
  },
  {
    key: "residualMomentum",
    label: "Residual Price Momentum",
    shortLabel: "Resid. Mom.",
    description: "Company-specific price confirmation after removing the equal-weight subsector move.",
    components: defs(RESIDUAL_MOMENTUM_COMPONENT_KEYS, {
      residual6m1m: "6-1m residual",
      residualSinceEarnings: "Residual since earnings",
    }),
  },
  {
    key: "cashQuality",
    label: "Cash Conversion & Accrual Quality",
    shortLabel: "Cash Quality",
    description: "Genuine cash-backed earnings vs accruals / temporary working-capital releases.",
    components: defs(CASH_QUALITY_COMPONENT_KEYS, {
      fcfConversion: "FCF conversion",
      accrualQuality: "Accrual quality",
      workingCapitalQuality: "Working-capital quality",
    }),
  },
  {
    key: "persistence",
    label: "Inflection Persistence",
    shortLabel: "Persistence",
    description: "Breadth of improvement across the core fundamentals over the last three transitions.",
    components: defs(PERSISTENCE_COMPONENT_KEYS, {
      persistenceBreadth: "Persistence breadth",
    }),
  },
  {
    key: "balanceSheet",
    label: "Balance-Sheet Strength",
    shortLabel: "Balance Sheet",
    description: "Solvency / refinancing / liquidity headroom: leverage, interest coverage, cash runway.",
    components: defs(BALANCE_SHEET_COMPONENT_KEYS, {
      netLeverageQuality: "Net leverage",
      interestCoverage: "Interest coverage",
      cashRunway: "Cash runway",
    }),
  },
  {
    key: "valuation",
    label: "Valuation",
    shortLabel: "Valuation",
    description: "Cross-sectional cheapness vs subsector peers (EV/EBITDA, P/E, FCF yield, dividend yield).",
    components: defs(VALUATION_BOX_COMPONENT_KEYS, {
      evEbitdaValue: "EV / EBITDA",
      peValue: "P / E",
      fcfYieldValue: "FCF yield",
      divYieldValue: "Dividend yield",
    }),
  },
  {
    key: "forecastConfidence",
    label: "Forecast Confidence",
    shortLabel: "Forecast Conf.",
    description: "Estimate dispersion (inverted, coverage-adjusted), dispersion trend, coverage, stability.",
    components: defs(FORECAST_CONFIDENCE_COMPONENT_KEYS, {
      epsDispQuality: "EPS dispersion",
      revDispQuality: "Revenue dispersion",
      ebitdaDispQuality: "EBITDA dispersion",
      dispChangeQuality: "Dispersion trend (90d)",
      analystCoverage: "Analyst coverage",
      consensusStability: "Consensus stability",
    }),
  },
  {
    key: "dilution",
    label: "Dilution & Capital-Raising",
    shortLabel: "Dilution",
    description: "Value transfer to/from common holders: share growth, net issuance, stock-based comp.",
    components: defs(DILUTION_COMPONENT_KEYS, {
      shareGrowthQuality: "Diluted share growth",
      shareCagr2yQuality: "2yr share CAGR",
      netIssuanceQuality: "Net equity issuance",
      sbcQuality: "SBC / revenue",
    }),
  },
];

export const BOX_KEYS: BoxKey[] = BOX_REGISTRY.map((b) => b.key);

/** Full flat component key as used in the scoring map / scoreJson. */
export function flatKey(box: BoxKey, component: string): string {
  return `${box}.${component}`;
}
