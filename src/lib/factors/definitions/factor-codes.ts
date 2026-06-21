/**
 * Canonical factor definitions — single source of truth for labels,
 * descriptions, and tooltips shown in the UI.
 */
import type { FactorCode, FactorDef, FactorInputType } from "@/types/factors";

/**
 * Naming convention (Apr 2026): each factor uses its full academic name.
 * - `label` is the long, fully-spelled academic name. Where the factor has a
 *   commonly-cited code in the literature (MKT-RF, SMB, HML, RMW, CMA, BAB,
 *   QMJ) we append it in parentheses; otherwise the label is just the name.
 * - `shortLabel` is the same academic name in a compact form for use in
 *   dense column headers / chart legends. We never use bare ticker-style
 *   codes ("EQ", "BAB", "QMJ") in the UI.
 *
 * ---------------------------------------------------------------------------
 * Excess vs raw factor definitions  (Phase 2 audit, 2026-04-25)
 * ---------------------------------------------------------------------------
 * The regression engine assumes every factor return is in EXCESS-OF-RF units
 * unless explicitly marked otherwise. Source mapping below is the canonical
 * definition the ingest pipeline writes to `FactorReturnDaily`.
 *
 *   Factor       Definition (raw vs excess)               Source
 *   ----------   ----------------------------------------- --------------------
 *   MKT_RF       Market excess return (excess of RF)      Ken French daily
 *   SMB          Small-minus-Big (long-short, RF-neutral) Ken French daily
 *   HML          High-minus-Low (long-short, RF-neutral)  Ken French daily
 *   RMW          Robust-minus-Weak (long-short)           Ken French daily
 *   CMA          Conservative-minus-Aggressive (LS)       Ken French daily
 *   MOM          12m-1m momentum (long-short)             Ken French daily
 *   RF           Risk-free 1-month T-bill (daily simple decimal) Ken French daily
 *   EQ           ACWI excess of RF                        Yahoo (ACWI)
 *   LOCAL_EQ     SPY − ACWI (cross-sectional spread, RF-neutral) Yahoo
 *   RATES        IEF excess of RF                         Yahoo (IEF)
 *   COMM         DBC excess of RF                         Yahoo (DBC)
 *   EM           EEM − SPY (spread, RF-neutral)           Yahoo
 *   FX           UUP excess of RF                         Yahoo (UUP)
 *   INFL         TIP − IEF (breakeven inflation spread)   Yahoo
 *   SHORT_VOL    SVXY excess of RF                        Yahoo (SVXY)
 *   TREND        DBMF excess of RF                        Yahoo (DBMF)
 *   BAB          Betting-Against-Beta (LS, RF-neutral)    AQR daily XLSX
 *   QMJ          Quality-Minus-Junk (LS, RF-neutral)      AQR daily XLSX
 *   CROWD        GVIP − SPY (spread, RF-neutral)          Yahoo
 *
 * Notes:
 *   • All long-short / spread factors are inherently RF-neutral and therefore
 *     comparable to MKT_RF/EQ on the regression's RHS without further excess
 *     transformation.
 *   • All ETF-based factors are converted from total return to excess return
 *     by subtracting the same RF (stored as daily simple decimal — KF native
 *     convention; FRED DGS1MO back-fill is calibrated to that daily level)
 *     used for the dependent variable on the LHS, so signs are interpretable
 *     as risk premia.
 *   • USMV-SPY and QUAL-SPY proxy splices for the AQR publish gap are written
 *     as the same factor row (BAB / QMJ respectively), normalised through
 *     `normalizeProxyToFf` so units stay consistent (see
 *     `factor-pipeline-macro.service.ts`).
 */
const FACTOR_INPUT_TYPE: Record<FactorCode, FactorInputType> = {
  MKT_RF: "RETURN",
  SMB: "RETURN",
  HML: "RETURN",
  RMW: "RETURN",
  CMA: "RETURN",
  MOM: "RETURN",
  RF: "AMBIGUOUS",
  EQ: "RETURN",
  LOCAL_EQ: "RETURN",
  RATES: "RETURN",
  COMM: "RETURN",
  EM: "RETURN",
  FX: "RETURN",
  INFL: "RETURN",
  SHORT_VOL: "RETURN",
  TREND: "RETURN",
  BAB: "RETURN",
  QMJ: "RETURN",
  CROWD: "RETURN",
};

const FACTOR_DEFS_BASE: Record<FactorCode, Omit<FactorDef, "inputType">> = {
  // -------------------------------------------------------------------------
  // Fama-French / Carhart factors (legacy presets)
  // -------------------------------------------------------------------------
  MKT_RF: {
    code: "MKT_RF",
    label: "Market Beta (MKT-RF)",
    shortLabel: "Market Beta",
    description:
      "Sensitivity of the portfolio to broad market movements, measured as excess return of the market over the risk-free rate. A beta of 1.2 means the portfolio tends to move 1.2× the market.",
    whyItMatters:
      "The single largest driver of equity portfolio risk. High market beta amplifies both gains and losses in bull/bear cycles.",
    howCalculated: "Market excess return over the risk-free rate (Ken French daily).",
    dataSource: "Daily market excess return (Mkt-RF), Kenneth French data library.",
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
    howCalculated: "Small-minus-Big: long small-cap, short large-cap (Ken French daily).",
    dataSource: "Daily SMB long-short return, Kenneth French data library.",
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
    howCalculated: "High-minus-Low: long high book/price (value), short low (growth) — Ken French daily.",
    dataSource: "Daily HML long-short return, Kenneth French data library.",
    units: "beta",
    color: "#f59e0b",
  },
  RMW: {
    code: "RMW",
    label: "Profitability (RMW)",
    shortLabel: "Profitability",
    description:
      "Exposure to the robust-minus-weak profitability factor. Positive loading means the portfolio leans toward companies with strong operating profitability.",
    whyItMatters:
      "Profitability is a quality indicator. High-RMW portfolios tend to hold up better in downturns and deliver more consistent returns.",
    howCalculated: "Robust-minus-Weak: long high-profitability, short low (Ken French daily).",
    dataSource: "Daily RMW long-short return, Kenneth French data library.",
    units: "beta",
    color: "var(--chart-4)",
  },
  CMA: {
    code: "CMA",
    label: "Investment (CMA)",
    shortLabel: "Investment",
    description:
      "Exposure to the conservative-minus-aggressive investment factor. Positive loading means the portfolio favors companies with conservative (low) asset growth.",
    whyItMatters:
      "Aggressive capital expenditure often signals overinvestment or value destruction. Low-investment firms tend to have better risk-adjusted returns.",
    howCalculated: "Conservative-minus-Aggressive: long low asset-growth, short high (Ken French daily).",
    dataSource: "Daily CMA long-short return, Kenneth French data library.",
    units: "beta",
    color: "#e879f9",
  },
  MOM: {
    code: "MOM",
    label: "Momentum",
    shortLabel: "Momentum",
    description:
      "Exposure to the momentum factor (winners minus losers over the past 12 months, skipping the most recent month). Positive loading means the portfolio tilts toward recent outperformers.",
    whyItMatters:
      "Momentum is one of the most persistent return anomalies but is subject to sharp reversals ('momentum crashes') during market recoveries.",
    howCalculated: "12-month-minus-1-month momentum: long winners, short losers (Ken French daily).",
    dataSource: "Daily momentum (UMD) long-short return, Kenneth French data library.",
    units: "beta",
    color: "#fb923c",
  },
  RF: {
    code: "RF",
    label: "Risk-Free Rate",
    shortLabel: "Risk-Free Rate",
    description:
      "The daily risk-free rate (3-month T-bill annualized, divided by 252). Used to convert total returns to excess returns for regression.",
    whyItMatters:
      "Return above the risk-free rate represents the compensation investors receive for taking equity risk.",
    howCalculated: "1-month T-bill rate as a daily simple decimal (Ken French; FRED DGS1MO back-fill for the recent tail).",
    dataSource: "1-month T-bill daily rate, Kenneth French data library (FRED DGS1MO back-fill for the recent tail).",
    units: "pct",
    color: "#94a3b8",
  },

  // -------------------------------------------------------------------------
  // Macro asset-class factors (MACRO14)
  // -------------------------------------------------------------------------
  EQ: {
    code: "EQ",
    label: "Global Equity",
    shortLabel: "Global Equity",
    description:
      "Exposure to broad global equity beta (ACWI excess of risk-free rate). Captures the global equity risk premium across developed and emerging markets.",
    whyItMatters:
      "Global equity beta is the dominant macro risk in any equity portfolio. Sensitivity to ACWI tracks systemic 'risk-on / risk-off' regime changes.",
    howCalculated: "ACWI total return minus the risk-free rate (Yahoo).",
    dataSource: "ACWI ETF daily adjusted-close total return (Yahoo), minus RF.",
    units: "beta",
    color: "#60a5fa",
  },
  LOCAL_EQ: {
    code: "LOCAL_EQ",
    label: "Local Equity (US − Global)",
    shortLabel: "Local Equity",
    description:
      "US equity premium over global equity (SPY − ACWI). Isolates the US-specific equity risk after controlling for global beta.",
    whyItMatters:
      "Captures home-bias and US-versus-rest-of-world performance dispersion. Often elevated during US tech outperformance.",
    howCalculated: "SPY minus ACWI return spread (Yahoo).",
    dataSource: "SPY and ACWI ETF daily total returns (Yahoo); spread = SPY − ACWI.",
    units: "beta",
    color: "#3b82f6",
  },
  RATES: {
    code: "RATES",
    label: "Interest-Rate Duration",
    shortLabel: "Duration",
    description:
      "Duration premium from intermediate-term Treasuries (IEF excess of risk-free rate). Positive beta means the position behaves like long-duration bonds.",
    whyItMatters:
      "Long-duration tilts amplify gains in falling-rate regimes and amplify losses when rates rise (e.g. 2022). Negative loading suggests rate-sensitive shorts.",
    howCalculated: "IEF (7-10y Treasuries) total return minus the risk-free rate (Yahoo).",
    dataSource: "IEF (7–10y Treasury) ETF daily total return (Yahoo), minus RF.",
    units: "beta",
    color: "#a78bfa",
  },
  COMM: {
    code: "COMM",
    label: "Commodities",
    shortLabel: "Commodities",
    description:
      "Exposure to broad commodity prices (DBC excess of risk-free rate). Captures energy, metals, and agricultural complex.",
    whyItMatters:
      "Commodity beta is a partial inflation hedge and often spikes during supply shocks or geopolitical stress.",
    howCalculated: "DBC (broad commodities) total return minus the risk-free rate (Yahoo).",
    dataSource: "DBC (broad commodities) ETF daily total return (Yahoo), minus RF.",
    units: "beta",
    color: "#facc15",
  },
  EM: {
    code: "EM",
    label: "Emerging Markets",
    shortLabel: "Emerging Markets",
    description:
      "Emerging-market equity premium over US equity (EEM − SPY). Isolates the EM-specific risk after controlling for US beta.",
    whyItMatters:
      "EM exposure adds beta to global growth, EM currency moves, and commodity demand. Sensitive to USD strength and risk appetite.",
    howCalculated: "EEM minus SPY return spread (Yahoo).",
    dataSource: "EEM and SPY ETF daily total returns (Yahoo); spread = EEM − SPY.",
    units: "beta",
    color: "#f472b6",
  },
  FX: {
    code: "FX",
    label: "US Dollar",
    shortLabel: "US Dollar",
    description:
      "USD strength vs basket of major currencies (UUP excess of risk-free rate). Positive loading means the position benefits from a stronger dollar.",
    whyItMatters:
      "USD strength compresses USD returns of international assets, weighs on commodities, and tightens global financial conditions.",
    howCalculated: "UUP (US dollar index ETF) total return minus the risk-free rate (Yahoo).",
    dataSource: "UUP (US dollar bullish) ETF daily total return (Yahoo), minus RF.",
    units: "beta",
    color: "#34d399",
  },
  INFL: {
    code: "INFL",
    label: "Inflation Breakeven",
    shortLabel: "Inflation",
    description:
      "Breakeven inflation expectations from TIPS minus nominal Treasuries (TIP − IEF). Positive beta means the position benefits when inflation expectations rise.",
    whyItMatters:
      "Inflation regime shifts re-price discount rates and reshape sector leadership (energy, financials benefit; long-duration tech suffers).",
    howCalculated: "TIP minus IEF return spread (breakeven inflation proxy) — Yahoo.",
    dataSource: "TIP and IEF ETF daily total returns (Yahoo); spread = TIP − IEF.",
    units: "beta",
    color: "#fb7185",
  },

  // -------------------------------------------------------------------------
  // Style / cross-sectional risk premia (MACRO14)
  // -------------------------------------------------------------------------
  SHORT_VOL: {
    code: "SHORT_VOL",
    label: "Short Volatility",
    shortLabel: "Short Volatility",
    description:
      "Daily excess return of SVXY (ProShares Short VIX Short-Term Futures ETF) over the risk-free rate. SVXY is short the front-month VIX futures roll — positive loading harvests futures roll-down in contango but suffers tail losses in vol spikes. NOTE: ProShares cut SVXY's effective leverage from −1.0x to −0.5x on 2018-02-27 after the XIV blow-up, so pre- and post-2018 series are structurally different short-vol exposures; β interpretation should account for the regime break.",
    whyItMatters:
      "Short-vol exposure carries steady carry in calm regimes but suffers severe drawdowns in events like Feb 2018, COVID-19, or any sharp VIX spike. The 2018 leverage cut roughly halved SVXY's daily move magnitude, so a single regression β masks the regime change.",
    howCalculated: "SVXY (short VIX short-term futures ETF) total return minus the risk-free rate (Yahoo).",
    dataSource: "SVXY (short VIX short-term futures) ETF daily total return (Yahoo), minus RF. Leverage cut from −1.0x to −0.5x on 2018-02-27.",
    units: "beta",
    color: "#f87171",
  },
  TREND: {
    code: "TREND",
    label: "Trend Following",
    shortLabel: "Trend Following",
    description:
      "Diversified CTA-style trend premium (DBMF managed futures, excess of risk-free rate). Captures systematic trend-following across asset classes.",
    whyItMatters:
      "Trend-following is one of the best historical equity-bear-market hedges (positive in 2008, 2022). Tends to lose in sharp reversals.",
    howCalculated: "DBMF (managed-futures ETF) total return minus the risk-free rate (Yahoo).",
    dataSource: "DBMF (managed futures) ETF daily total return (Yahoo), minus RF.",
    units: "beta",
    color: "#10b981",
  },
  BAB: {
    code: "BAB",
    label: "Betting-Against-Beta (BAB)",
    shortLabel: "Betting-Against-Beta",
    description:
      "Betting-Against-Beta factor (long leveraged low-beta, short high-beta). From AQR's published US daily series.",
    whyItMatters:
      "Low-beta stocks have historically outperformed on a risk-adjusted basis. Positive Betting-Against-Beta loading indicates a defensive, low-vol tilt.",
    howCalculated: "Betting-Against-Beta long-short portfolio: long leveraged low-beta, short high-beta (AQR daily series).",
    dataSource: "AQR Betting-Against-Beta US daily series (AQR data library); USMV−SPY proxy splice for the recent publish gap.",
    units: "beta",
    color: "#84cc16",
  },
  QMJ: {
    code: "QMJ",
    label: "Quality-Minus-Junk (QMJ)",
    shortLabel: "Quality",
    description:
      "Quality-Minus-Junk factor (long high-quality, short low-quality). From AQR's published US daily series.",
    whyItMatters:
      "Quality companies (profitable, stable, well-managed) are more defensive and tend to compound steadily through cycles.",
    howCalculated: "Quality-Minus-Junk long-short portfolio: long high-quality, short low-quality (AQR daily series).",
    dataSource: "AQR Quality-Minus-Junk US daily series (AQR data library); QUAL−SPY proxy splice for the recent publish gap.",
    units: "beta",
    color: "#06b6d4",
  },
  CROWD: {
    code: "CROWD",
    label: "Hedge-Fund Crowding",
    shortLabel: "Crowding",
    description:
      "Hedge-fund crowding via the Goldman Sachs Hedge Fund VIP basket (GVIP − SPY). Positive loading means the position overlaps with hedge fund consensus longs.",
    whyItMatters:
      "Crowded positions are vulnerable to fast deleveraging events when hedge funds unwind together (e.g. Jan 2021, Feb 2024 momentum unwinds).",
    howCalculated: "GVIP (Goldman Sachs hedge-fund VIP basket) minus SPY return spread (Yahoo).",
    dataSource: "GVIP (GS hedge-fund VIP) and SPY ETF daily total returns (Yahoo); spread = GVIP − SPY.",
    units: "beta",
    color: "#c084fc",
  },
};

export const FACTOR_DEFS: Record<FactorCode, FactorDef> = Object.fromEntries(
  Object.entries(FACTOR_DEFS_BASE).map(([code, def]) => [
    code,
    { ...def, inputType: FACTOR_INPUT_TYPE[code as FactorCode] },
  ]),
) as Record<FactorCode, FactorDef>;

/** Ordered list of factor codes by their canonical display order. */
export const FACTOR_DISPLAY_ORDER: FactorCode[] = [
  "MKT_RF",
  "SMB",
  "HML",
  "RMW",
  "CMA",
  "MOM",
];

/** Display order for the MACRO14 model — matches the user-supplied factor list. */
export const MACRO14_DISPLAY_ORDER: FactorCode[] = [
  "EQ",
  "RATES",
  "COMM",
  "EM",
  "FX",
  "INFL",
  "LOCAL_EQ",
  "SHORT_VOL",
  "TREND",
  "BAB",
  "MOM",
  "QMJ",
  "HML",
  "CROWD",
];

/** Look up a factor definition by code. */
export function getFactorDef(code: FactorCode): FactorDef {
  return FACTOR_DEFS[code] ?? {
    code,
    label: code,
    shortLabel: code,
    description: code,
    whyItMatters: "",
    howCalculated: "",
    units: "beta",
    color: "#94a3b8",
    inputType: "AMBIGUOUS",
  };
}

export function getFactorInputType(code: FactorCode): FactorInputType {
  return FACTOR_INPUT_TYPE[code] ?? "AMBIGUOUS";
}
