import { z } from "zod";

// ---------------------------------------------------------------------------
// Factor analysis query params
// ---------------------------------------------------------------------------

/**
 * All model preset names accepted by the API. Includes legacy presets so old
 * persisted snapshot reads and external callers do not break. The *visible*
 * dropdown in the UI is a subset (see `MODEL_PRESET_NAMES` in
 * `lib/factors/definitions/model-presets.ts`).
 */
export const MODEL_PRESET_NAMES = ["CAPM", "FF3", "CARHART4", "FF5", "EXTENDED", "MACRO14"] as const;
/** Approximate calendar-day labels mapping to the trading-day presets in `FACTOR_WINDOW_TRADING_DAYS`. */
export const FACTOR_WINDOW_VALUES = [30, 60, 90, 180, 365, 548, 730, 1260] as const;

/** Window in trading days for each preset. Calendar-day labels in the UI map to these. */
export const FACTOR_WINDOW_TRADING_DAYS = {
  D30: 21, // ~30 calendar days
  D60: 42,
  D90: 63,
  D180: 126,
  D365: 252,
  Y1_5: 378, // ~1.5 calendar years
  Y2: 504,
  Y5: 1260,
} as const;

export const factorQueryParams = z.object({
  portfolioId: z.string().min(1),
  model: z.enum(MODEL_PRESET_NAMES).optional().default("MACRO14"),
  window: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(20, Math.min(2520, Number(v))) : 378))
    .pipe(z.number().int().min(20).max(2520)),
  ew: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : null))
    .pipe(z.number().positive().nullable()),
  from: z.string().optional(),
  to: z.string().optional(),
  benchmark: z.enum(["SP500", "NASDAQ", "DOW"]).optional(),
});

/** Per-stock grid query (no portfolioId — universe-driven). */
export const factorPerStockQuery = z.object({
  model: z.enum(MODEL_PRESET_NAMES).optional().default("MACRO14"),
  window: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(20, Math.min(2520, Number(v))) : 378))
    .pipe(z.number().int().min(20).max(2520)),
  sector: z.string().optional(),
  subTheme: z.string().optional(),
  /**
   * Optional attribution period. When present, the route overlays each row's
   * Return / Alpha / Unexplained columns with the values restricted to this
   * trailing period (betas / risk / R² / vol stay on the full horizon window).
   */
  period: z.enum(["1D", "5D", "1M", "3M", "6M", "1Y"]).optional(),
});

export const factorDriversQuery = factorQueryParams.extend({
  groupBy: z.enum(["position", "sector", "subTheme"]).optional().default("sector"),
  topN: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(3, Math.min(20, Number(v))) : 5))
    .pipe(z.number().int().min(3).max(20)),
});

export const factorScenarioRunBody = z.object({
  portfolioId: z.string().min(1),
  model: z.enum(MODEL_PRESET_NAMES).optional().default("MACRO14"),
  window: z.number().int().min(20).max(2520).optional().default(378),
  scenarioKey: z.string().optional(),
  customShocks: z
    .array(z.object({ code: z.string().min(1), shockValue: z.number() }))
    .optional(),
});

export const factorMarketQuery = z.object({
  corrWindow: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(60, Math.min(504, Number(v))) : 252))
    .pipe(z.number().int()),
  model: z.enum(MODEL_PRESET_NAMES).optional(),
});

export const parseUniverseBody = z.object({
  text: z.string().min(1),
  format: z.enum(["paste", "csv"]).optional(),
});

export const createUniverseBody = z.object({
  name: z.string().min(1).max(120),
});

export const constituentRow = z.object({
  ticker: z.string().min(1),
  companyName: z.string().min(1),
  sector: z.string().min(1),
  subTheme: z.string().min(1),
});

export const saveConstituentsBody = z.object({
  rows: z.array(constituentRow).min(1),
});

export const marketMapQuery = z.object({
  metric: z.enum(["RETURN", "EXCESS_RETURN", "VOLATILITY", "SHARPE"]),
  rowLevel: z.enum(["SECTOR", "SUB_THEME", "COMPANY"]),
  benchmark: z.enum(["SP500", "NASDAQ", "DOW"]).optional(),
  sector: z.string().optional(),
  subTheme: z.string().optional(),
});

export const factorPerformanceQuery = z.object({
  metric: z
    .enum(["RETURN", "EXCESS_RETURN", "VOLATILITY", "SHARPE"])
    .optional()
    .default("RETURN"),
  benchmark: z.enum(["SP500", "NASDAQ", "DOW"]).optional().default("SP500"),
});

export const portfolioPositionRow = z.object({
  ticker: z.string().min(1),
  shares: z.number().positive(),
  isShort: z.boolean().optional().default(false),
  sector: z.string().nullable().optional(),
});

export const portfolioPositionsBody = z.object({
  positions: z.array(portfolioPositionRow).min(1),
});

export const renamePortfolioBody = z.object({
  name: z.string().min(1).max(120),
});
