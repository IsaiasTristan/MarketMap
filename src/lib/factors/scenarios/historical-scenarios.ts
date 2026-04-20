/**
 * Historical and synthetic factor scenario presets.
 *
 * Historical presets use actual factor return windows from FactorReturnDaily
 * to define the shock magnitudes. Synthetic presets use analyst-defined
 * hypothetical shocks expressed in factor units.
 *
 * All shock values are expressed as single-period (not annualized) factor returns
 * — i.e., the same units as the daily FactorReturnDaily values but scaled to
 * represent a "shock scenario" (e.g., a week of extreme returns).
 */
import type { ScenarioDefinition } from "@/types/factors";

/**
 * Synthetic (analyst-defined) scenario presets.
 * Historical presets are computed dynamically from real DB data in the service layer.
 */
export const SYNTHETIC_SCENARIOS: ScenarioDefinition[] = [
  {
    key: "market_down_10",
    label: "Market Down −10%",
    description:
      "Simulates a broad equity market drawdown of roughly −10% over the scenario horizon.",
    shocks: [
      { code: "MKT_RF", shockValue: -0.10 },
    ],
  },
  {
    key: "market_up_10",
    label: "Market Up +10%",
    description:
      "Simulates a broad equity market rally of roughly +10%.",
    shocks: [
      { code: "MKT_RF", shockValue: 0.10 },
    ],
  },
  {
    key: "momentum_crash",
    label: "Momentum Crash",
    description:
      "Simulates a sharp reversal in momentum (recent winners sell off, losers rally). "
      + "Characteristic of early bear-market recoveries.",
    shocks: [
      { code: "MOM", shockValue: -0.15 },
      { code: "MKT_RF", shockValue: -0.05 },
    ],
  },
  {
    key: "value_rebound",
    label: "Value Rebound",
    description:
      "Simulates a rotation into value stocks (high book-to-price) away from growth. "
      + "Similar to the November 2020 vaccine rotation.",
    shocks: [
      { code: "HML", shockValue: 0.12 },
      { code: "MOM", shockValue: -0.08 },
    ],
  },
  {
    key: "quality_flight",
    label: "Quality Flight-to-Safety",
    description:
      "Simulates a flight to high-quality, low-leverage stocks during market stress.",
    shocks: [
      { code: "RMW", shockValue: 0.08 },
      { code: "CMA", shockValue: 0.05 },
      { code: "MKT_RF", shockValue: -0.07 },
    ],
  },
  {
    key: "growth_drawdown",
    label: "Growth / Tech Drawdown",
    description:
      "Simulates a drawdown in growth and momentum-heavy names. "
      + "Similar to early 2022 rate shock.",
    shocks: [
      { code: "MKT_RF", shockValue: -0.08 },
      { code: "HML", shockValue: 0.06 },
      { code: "MOM", shockValue: -0.10 },
    ],
  },
  {
    key: "small_cap_rout",
    label: "Small-Cap Rout",
    description:
      "Simulates underperformance of small-cap stocks relative to large-caps (negative SMB).",
    shocks: [
      { code: "SMB", shockValue: -0.10 },
      { code: "MKT_RF", shockValue: -0.04 },
    ],
  },
];

/** Keys of scenarios that are loaded from real FactorReturnDaily data. */
export const HISTORICAL_SCENARIO_KEYS = [
  {
    key: "gfc_2008",
    label: "GFC Crisis (Sep–Oct 2008)",
    description:
      "Factor returns realized during the peak of the Global Financial Crisis — "
      + "the two worst months of the 2008 crash.",
    isHistorical: true,
    historicalWindow: { start: "2008-09-01", end: "2008-10-31" },
  },
  {
    key: "covid_crash_2020",
    label: "COVID Crash (Feb–Mar 2020)",
    description:
      "Factor returns realized during the swift pandemic-driven market collapse "
      + "(-34% in 33 days on the S&P 500).",
    isHistorical: true,
    historicalWindow: { start: "2020-02-19", end: "2020-03-23" },
  },
  {
    key: "2022_rate_shock",
    label: "Rate Shock (Jan–Jun 2022)",
    description:
      "Factor returns during the aggressive Fed rate hiking cycle that crushed "
      + "duration-sensitive and growth stocks.",
    isHistorical: true,
    historicalWindow: { start: "2022-01-03", end: "2022-06-30" },
  },
  {
    key: "covid_recovery_2020",
    label: "COVID Recovery (Apr–Nov 2020)",
    description:
      "The rapid factor regime shift after March 2020 lows, including the "
      + "November vaccine momentum crash.",
    isHistorical: true,
    historicalWindow: { start: "2020-04-01", end: "2020-11-30" },
  },
] as const;

export type HistoricalScenarioKey = typeof HISTORICAL_SCENARIO_KEYS[number]["key"];
