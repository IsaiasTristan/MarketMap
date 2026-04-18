import { z } from "zod";

export const parseUniverseBody = z.object({
  text: z.string().min(1),
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

export const portfolioHoldingsBody = z.object({
  holdings: z
    .array(
      z.object({
        ticker: z.string().min(1),
        weight: z.number().positive(),
      })
    )
    .min(1),
});
