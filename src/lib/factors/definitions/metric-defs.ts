/**
 * Canonical definitions for the DERIVED metrics shown on the Factors tab
 * (the non-factor columns and header cards: R², Vol, Alpha, Unexplained,
 * Total Return, Market Beta, etc.). Single source of truth so the same
 * concise definition / calculation / data reference renders consistently in
 * every tooltip (grid headers, header cards, waterfall residual rows).
 *
 * Mirrors the shape consumed by `FactorTooltip` (name / definition /
 * howCalculated / dataUsed).
 */

export type MetricKey =
  | "totalReturn"
  | "rSquared"
  | "realizedVol"
  | "alpha"
  | "residual"
  | "marketBeta"
  | "topFactorTilt"
  | "factorConcentration"
  | "systematicRisk"
  | "idiosyncratic";

export interface MetricDef {
  name: string;
  definition: string;
  howCalculated: string;
  /** Underlying data/series the metric is computed from. */
  dataUsed: string;
}

const METRIC_DEFS: Record<MetricKey, MetricDef> = {
  totalReturn: {
    name: "Total Return",
    definition:
      "The realized total return over the selected Attribution Period — the actual price performance, dividend-inclusive, independent of the factor model.",
    howCalculated:
      "Geometric compound of daily returns over the period: exp(Σ ln(1 + r_t)) − 1. For the portfolio Total row it is the realized period return that the Total Return Decomposition headline reconciles to.",
    dataUsed:
      "Daily adjusted-close prices (dividend-inclusive) from Yahoo, over the period's trading days.",
  },
  rSquared: {
    name: "R² (Goodness of Fit)",
    definition:
      "Share of the security's return variance explained by the factor model. 1.0 = fully explained by factors; near 0 = mostly idiosyncratic.",
    howCalculated:
      "In-sample R² of the multivariate OLS regression of excess return on the factor returns, over the horizon window.",
    dataUsed:
      "Daily security excess returns (Yahoo adjClose − RF) regressed on the MACRO14 factor return series.",
  },
  realizedVol: {
    name: "Realized Volatility",
    definition:
      "Annualized standard deviation of the security's daily returns over the horizon window — how much the price actually swung.",
    howCalculated:
      "Sample standard deviation of daily returns × √252.",
    dataUsed:
      "Daily adjusted-close returns (Yahoo) over the horizon window.",
  },
  alpha: {
    name: "Alpha",
    definition:
      "Return not explained by any factor exposure — the regression intercept. Positive alpha is performance earned beyond the factor bets.",
    howCalculated:
      "Σ of the rolling-OLS intercept α_t over the selected period (log or simple space per the attribution mode). Annualized on the header card.",
    dataUsed:
      "Rolling multivariate OLS of daily excess returns on the MACRO14 factors (Yahoo prices, factor series).",
  },
  residual: {
    name: "Unexplained Residual",
    definition:
      "The part of realized return left over after factor contributions AND alpha — model error / unexplained drift over the period.",
    howCalculated:
      "Σ of the rolling-OLS residual ε_t = y_t − ŷ_t over the selected period; for the portfolio it is Σ wᵢ·εᵢ,t with a Newey-West HAC standard error.",
    dataUsed:
      "Rolling multivariate OLS residual stream (Yahoo prices, MACRO14 factor series).",
  },
  marketBeta: {
    name: "Market Beta",
    definition:
      "Sensitivity to broad market moves. Beta = 1 tracks the market; >1 amplifies gains and losses, <1 dampens them.",
    howCalculated:
      "OLS loading on the Global Equity / market factor from the portfolio's end-of-window regression.",
    dataUsed:
      "Portfolio daily excess returns regressed on the market factor over the horizon window.",
  },
  topFactorTilt: {
    name: "Top Factor Tilt",
    definition:
      "The single factor the portfolio is most exposed to right now — the largest absolute beta across the model.",
    howCalculated:
      "max |β_f| across the portfolio's end-of-window factor loadings; the sign shows the direction of the tilt.",
    dataUsed:
      "Portfolio end-of-window multivariate OLS betas on the MACRO14 factors.",
  },
  factorConcentration: {
    name: "Factor Concentration",
    definition:
      "How much of the portfolio's factor risk is concentrated in its largest exposures versus spread across many factors.",
    howCalculated:
      "Share of total systematic (factor) variance contributed by the top factor exposures, from the risk decomposition.",
    dataUsed:
      "Portfolio factor covariance matrix and betas over the horizon window.",
  },
  systematicRisk: {
    name: "Systematic Risk",
    definition:
      "Share of the portfolio's total variance explained by factor exposures (systematic) rather than stock-specific noise (idiosyncratic).",
    howCalculated:
      "Euler variance decomposition: β'Σβ / (β'Σβ + σ²_idio) over the horizon window.",
    dataUsed:
      "Portfolio betas, factor covariance matrix, and idiosyncratic residual variance from the end-of-window OLS.",
  },
  idiosyncratic: {
    name: "Idiosyncratic (Stock-specific)",
    definition:
      "Share of variance NOT explained by any factor — purely stock-specific risk that diversifies away in a large book.",
    howCalculated:
      "1 − systematic share = σ²_idio / (β'Σβ + σ²_idio); on a period slice it is Σ α_t² / Σ(contrib² + α²).",
    dataUsed:
      "Regression residual variance and factor covariance over the horizon window / period slice.",
  },
};

/** Look up a derived-metric definition by key. */
export function getMetricDef(key: MetricKey): MetricDef {
  return METRIC_DEFS[key];
}
