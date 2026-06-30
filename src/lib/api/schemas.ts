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
  from: z.string().optional(),
  to: z.string().optional(),
  benchmark: z.enum(["SP500", "NASDAQ", "DOW"]).optional(),
});

/** Portfolio news feed query. */
export const portfolioNewsQuery = z.object({
  portfolioId: z.string().min(1),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(1, Math.min(40, Number(v))) : 40))
    .pipe(z.number().int().min(1).max(40)),
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

/** Price-correlation tab window: 1M=21, 3M=63, 6M=126, 1Y=252 trading days. */
const PRICE_CORR_WINDOWS = [21, 63, 126, 252] as const;
export const marketCorrelationQuery = z.object({
  window: z
    .string()
    .optional()
    .transform((v) => {
      const n = v ? Number(v) : 252;
      return (PRICE_CORR_WINDOWS as readonly number[]).includes(n) ? n : 252;
    })
    .pipe(z.number().int()),
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

export const updateConstituentBody = z.object({
  companyName: z.string().min(1),
  sector: z.string().min(1),
  subTheme: z.string().min(1),
});

export const marketMapQuery = z.object({
  metric: z.enum(["RETURN", "EXCESS_RETURN", "VOLATILITY", "SHARPE"]),
  rowLevel: z.enum(["SECTOR", "SUB_THEME", "COMPANY"]),
  benchmark: z.enum(["SP500", "NASDAQ", "DOW"]).optional(),
  sector: z.string().optional(),
  subTheme: z.string().optional(),
  /** Opt-in extended-hours overlay (pre/post-market price replacement on the
   *  series endpoint). Server only honours the flag when the in-memory
   *  extended-hours snapshot is fresh for a PRE/POST session; otherwise the
   *  response is identical to the close-based grid (and `extended.applied`
   *  reads `false`). String form "1" / "true" accepted. */
  extended: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export const factorPerformanceQuery = z.object({
  metric: z
    .enum(["RETURN", "EXCESS_RETURN", "VOLATILITY", "SHARPE"])
    .optional()
    .default("RETURN"),
  benchmark: z.enum(["SP500", "NASDAQ", "DOW"]).optional().default("SP500"),
});

/** Per-factor top-movers query (universe-driven; horizon drives the period). */
export const factorTopMoversQuery = z.object({
  horizon: z.enum(["D1", "D5", "M1", "M3", "M6", "Y1"]).optional().default("D1"),
  mode: z.enum(["simple", "log"]).optional().default("log"),
  window: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(20, Math.min(2520, Number(v))) : 252))
    .pipe(z.number().int().min(20).max(2520)),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(1, Math.min(50, Number(v))) : 20))
    .pipe(z.number().int().min(1).max(50)),
});

export const portfolioPositionRow = z.object({
  ticker: z.string().min(1).optional(),
  shares: z.number().positive().optional(),
  isShort: z.boolean().optional().default(false),
  sector: z.string().nullable().optional(),
  isCash: z.boolean().optional().default(false),
  cashAmount: z.number().positive().optional(),
}).refine(
  (row) => row.isCash ? row.cashAmount != null : (row.ticker && row.shares != null),
  { message: "Equity rows need ticker + shares; cash rows need cashAmount" },
);

export const addCashPositionBody = z.object({
  portfolioId: z.string().min(1),
  isCash: z.literal(true),
  cashAmount: z.number().positive(),
});

export const portfolioPositionsBody = z.object({
  positions: z.array(portfolioPositionRow).min(1),
});

export const renamePortfolioBody = z.object({
  name: z.string().min(1).max(120),
});

// ---------------------------------------------------------------------------
// Engine 1 — analyst revision research queue
// ---------------------------------------------------------------------------

export const researchQueueQuery = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(1, Math.min(3000, Number(v))) : undefined))
    .pipe(z.number().int().min(1).max(3000).optional()),
});

export const researchTrajectoryQuery = z.object({
  ticker: z.string().min(1).max(12).transform((s) => s.trim().toUpperCase()),
});

export const researchGroupQuery = z.object({
  groupType: z.enum(["SECTOR", "SUBSECTOR"]).optional().default("SUBSECTOR"),
  weeks: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(2, Math.min(104, Number(v))) : 52))
    .pipe(z.number().int().min(2).max(104)),
});

export const researchEventsQuery = z.object({
  ticker: z
    .string()
    .max(12)
    .optional()
    .transform((s) => (s && s.trim() ? s.trim().toUpperCase() : undefined)),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(1, Math.min(1000, Number(v))) : undefined))
    .pipe(z.number().int().min(1).max(1000).optional()),
});

export const researchIngestBody = z.object({
  snapshotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  refreshReference: z.boolean().optional(),
  referenceSource: z.enum(["MARKET_MAP", "FMP_SCREENER"]).optional(),
  universeId: z.string().optional(),
  backfillEvents: z.boolean().optional(),
  enrichProfiles: z.boolean().optional(),
  maxUniverse: z.number().int().min(1).max(5000).optional(),
});

// ─── Engine 2 — Fundamentals (discovery) ───────────────────────────────────

export const fundamentalsQueueQuery = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(1, Math.min(3000, Number(v))) : undefined))
    .pipe(z.number().int().min(1).max(3000).optional()),
});

export const fundamentalsDiligenceQuery = z.object({
  ticker: z.string().min(1).max(12).transform((s) => s.trim().toUpperCase()),
});

export const fundamentalsFinancialsQuery = z.object({
  ticker: z.string().min(1).max(12).transform((s) => s.trim().toUpperCase()),
  basis: z.enum(["annual", "quarter"]).optional().default("annual"),
});

export const fundamentalsIngestBody = z.object({
  snapshotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  refreshReference: z.boolean().optional(),
  referenceSource: z.enum(["MARKET_MAP", "FMP_SCREENER"]).optional(),
  universeId: z.string().min(1).optional(),
  backfill: z.boolean().optional(),
  enrichProfiles: z.boolean().optional(),
  maxUniverse: z.number().int().min(1).max(5000).optional(),
  quarters: z.number().int().min(4).max(60).optional(),
});
