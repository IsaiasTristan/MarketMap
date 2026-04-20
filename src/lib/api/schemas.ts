import { z } from "zod";

// ---------------------------------------------------------------------------
// Factor analysis query params
// ---------------------------------------------------------------------------

export const MODEL_PRESET_NAMES = ["CAPM", "FF3", "CARHART4", "FF5", "EXTENDED"] as const;
export const FACTOR_WINDOW_VALUES = [20, 60, 120, 252] as const;

export const factorQueryParams = z.object({
  portfolioId: z.string().min(1),
  model: z.enum(MODEL_PRESET_NAMES).optional().default("FF5"),
  window: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(20, Math.min(500, Number(v))) : 252))
    .pipe(z.number().int().min(20).max(500)),
  ew: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : null))
    .pipe(z.number().positive().nullable()),
  from: z.string().optional(),
  to: z.string().optional(),
  benchmark: z.enum(["SP500", "NASDAQ", "DOW"]).optional(),
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
  model: z.enum(MODEL_PRESET_NAMES).optional().default("FF5"),
  window: z.number().int().min(20).max(500).optional().default(252),
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

export const portfolioHoldingRow = z.object({
  ticker: z.string().min(1),
  weight: z.number().min(0).max(1),
  shares: z.number().positive().nullable().optional(),
  entryDate: z.string().nullable().optional(), // ISO date "YYYY-MM-DD" or null
  sector: z.string().nullable().optional(),
});

export const portfolioHoldingsBody = z.object({
  holdings: z.array(portfolioHoldingRow).min(1),
});

export const renamePortfolioBody = z.object({
  name: z.string().min(1).max(120),
});
