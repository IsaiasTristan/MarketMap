/**
 * Plain-English tooltips and institutional definitions for every metric
 * shown in the Factor Analysis tab.
 *
 * Keyed by metric identifier so UI components can look up via a constant
 * instead of embedding text in JSX.
 */

export interface MetricExplanation {
  /** Institutional-grade concise name. */
  name: string;
  /** Plain-English one-sentence explanation for retail users. */
  plainEnglish: string;
  /** Technical / institutional definition. */
  definition: string;
  formula?: string;
  goodValue?: string;
}

export const METRIC_EXPLANATIONS: Record<string, MetricExplanation> = {
  factor_beta: {
    name: "Factor Beta (Loading)",
    plainEnglish: "How much your portfolio moves when this factor moves 1 unit.",
    definition:
      "The regression coefficient from a joint OLS regression of portfolio excess returns "
      + "on the chosen factor return series. A beta of 1.2 on MKT_RF means a 1% market move "
      + "tends to produce a 1.2% portfolio move, all else equal.",
    formula: "β_f = Cov(r_p, r_f) / Var(r_f)  [joint regression]",
    goodValue: "Depends on intended exposure.",
  },
  t_stat: {
    name: "t-Statistic",
    plainEnglish: "How confident we are that this exposure is real, not random noise.",
    definition:
      "The ratio of the estimated beta to its standard error. Values with |t| > 2 "
      + "are statistically significant at roughly the 5% level (assuming normal errors).",
    formula: "t = β / SE(β)",
    goodValue: "|t| > 2.0 for statistical significance.",
  },
  r_squared: {
    name: "R-Squared",
    plainEnglish: "What fraction of portfolio return variation is explained by the chosen factors.",
    definition:
      "The coefficient of determination from the factor regression. A value of 0.80 means "
      + "the factors explain 80% of portfolio return variance, and 20% is idiosyncratic.",
    formula: "R² = 1 − SSR / SST",
    goodValue:
      "0.70–0.90 for well-diversified equity portfolios; lower for concentrated or thematic books.",
  },
  adj_r_squared: {
    name: "Adjusted R-Squared",
    plainEnglish: "Like R², but penalizes for adding extra factors that don't help.",
    definition:
      "R² adjusted for the number of factors in the model. Prevents over-fitting "
      + "when comparing models with different numbers of regressors.",
    formula: "Adj. R² = 1 − (1 − R²) × (n−1)/(n−k−1)",
  },
  alpha: {
    name: "Annualized Alpha",
    plainEnglish:
      "The return your portfolio earned that cannot be explained by factor exposures — potential skill.",
    definition:
      "The regression intercept annualized (× 252). Positive alpha suggests the portfolio "
      + "generated returns beyond what its systematic factor tilts would predict. "
      + "It should be interpreted cautiously: short estimation periods produce noisy alphas.",
    formula: "α_ann = α_daily × 252",
    goodValue: "Statistically significant positive alpha with |t| > 2.",
  },
  pct_risk_contrib: {
    name: "% Risk Contribution",
    plainEnglish: "What share of total portfolio risk this factor is responsible for.",
    definition:
      "The percent of total portfolio variance attributable to this factor, "
      + "via the Euler decomposition: PCR_f = β_f × (Σβ)_f / σ²_p.",
    formula: "PCR_f = β_f × (Σβ)_f / σ²_p",
    goodValue: "No single factor should dominate (e.g. > 60%) unless intentional.",
  },
  marginal_cr: {
    name: "Marginal Contribution to Risk",
    plainEnglish: "How much total portfolio volatility would change if you slightly increased exposure to this factor.",
    definition:
      "The partial derivative of portfolio volatility with respect to the factor beta: "
      + "MCR_f = (Σβ)_f / σ_p.",
    formula: "MCR_f = (Σβ)_f / σ_p",
  },
  systematic_share: {
    name: "Systematic Risk Share",
    plainEnglish: "How much of portfolio risk is driven by broad market factors versus stock-specific risk.",
    definition:
      "The fraction of total portfolio variance explained by the factor model: "
      + "σ²_sys / (σ²_sys + σ²_idio). "
      + "A high systematic share means factor tilts dominate; a low share means "
      + "individual stock selection is the key risk driver.",
    goodValue:
      "60–85% for diversified long-only; lower for concentrated or long/short books.",
  },
  idiosyncratic_share: {
    name: "Idiosyncratic Risk Share",
    plainEnglish: "The portion of portfolio risk that comes from individual stock behavior, not broad factors.",
    definition:
      "1 − systematic share. Driven by company-specific events, earnings surprises, "
      + "and other stock-level noise not captured by the factor model.",
  },
  concentration_hhi: {
    name: "Factor Concentration Score (HHI)",
    plainEnglish: "How concentrated factor risk is — lower is more diversified.",
    definition:
      "Herfindahl-Hirschman Index computed on absolute factor risk contributions. "
      + "0 = perfectly diversified; 1 = one factor explains all risk.",
    formula: "HHI = Σ (|RC_f| / Σ|RC_f|)²",
    goodValue: "< 0.30 for diversified multi-factor exposure.",
  },
  rolling_beta: {
    name: "Rolling Factor Beta",
    plainEnglish: "How your factor exposure has changed over time.",
    definition:
      "The factor beta estimated from a rolling regression window. "
      + "Drift in the rolling beta indicates unintentional factor tilts building up "
      + "or fading as the portfolio composition changes.",
  },
  holdings_implied: {
    name: "Holdings-Implied Score",
    plainEnglish: "A cross-check on factor exposure estimated from what you actually own today.",
    definition:
      "A style z-score computed from each position's fundamental characteristics "
      + "(size = log market cap, value = B/P + E/P + FCF yield, quality = ROE + margin − leverage, "
      + "momentum = 12-1 month price return). Weighted by portfolio weight. "
      + "This differs from the returns-based regression beta: it reflects current holdings "
      + "characteristics rather than historical co-movement.",
  },
  pct_return_contrib: {
    name: "% Return Contribution",
    plainEnglish: "How much of your total return came from this factor over the selected period.",
    definition:
      "Factor return attribution using rolling betas: attribution_f = β_f × f_t summed "
      + "over the period, divided by total portfolio return.",
  },
  scenario_pnl: {
    name: "Estimated Scenario P&L",
    plainEnglish: "How much money your portfolio might make or lose in this hypothetical scenario.",
    definition:
      "Linear approximation: ΔP ≈ Σ_f β_f × Δf. Assumes factor exposures are stable "
      + "during the scenario — a reasonable assumption for short-horizon shocks but "
      + "not for extended stress periods where positions and exposures change.",
    formula: "ΔP = Σ β_f × Δf_scenario",
    goodValue: "Use to identify hidden tail risks; treat as directional, not precise.",
  },
};

/** Look up an explanation by metric key. Returns a generic placeholder if not found. */
export function getExplanation(key: string): MetricExplanation {
  return (
    METRIC_EXPLANATIONS[key] ?? {
      name: key,
      plainEnglish: key,
      definition: key,
    }
  );
}
