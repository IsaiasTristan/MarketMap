/**
 * GET /api/analysis/factors/per-stock/timeseries
 *
 * Per-stock daily factor decomposition over the requested regression window.
 * Returns the full daily series for one ticker so the per-stock detail panel
 * can render stacked-area cumulative attribution and rolling β / risk-share
 * charts.
 *
 * Query params:
 *   - ticker         required          (case-insensitive; lookup is uppercase)
 *   - model          ModelPresetName   (default MACRO14)
 *   - window         trading days      (default 378) — chart display window
 *   - rollingWindow  trading days      (optional)    — rolling-OLS lookback;
 *                                                     defaults to min(60, window)
 *
 * Response shape (selected fields):
 *   - dates                  full loaded aligned series (length = windowUsed)
 *   - displayStartIndex      first day to display (visible region is
 *                            [displayStartIndex, n)); identity sums skip
 *                            i < displayStartIndex
 *   - burnInIndex            first day with a valid rolling fit
 *                            (≤ displayStartIndex; only matters to the UI
 *                            when it overlaps the visible region — e.g. on
 *                            the windowFallback path)
 *   - windowFallback         set when the requested rolling window had to
 *                            shrink below `rollingWindow` to fit the
 *                            available history
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MODEL_PRESET_NAMES } from "@/lib/api/schemas";
import { runPerStockTimeseries } from "@/server/services/factor-per-stock-timeseries.service";
import type { ModelPresetName } from "@/types/factors";

export const maxDuration = 60;

const querySchema = z.object({
  ticker: z.string().min(1),
  model: z.enum(MODEL_PRESET_NAMES).optional().default("MACRO14"),
  window: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(20, Math.min(2520, Number(v))) : 378))
    .pipe(z.number().int().min(20).max(2520)),
  rollingWindow: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(20, Math.min(2520, Number(v))) : undefined))
    .pipe(z.number().int().min(20).max(2520).optional()),
});

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = querySchema.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { ticker, model, window: win, rollingWindow } = parsed.data;
  const result = await runPerStockTimeseries({
    ticker,
    model: model as ModelPresetName,
    window: win,
    rollingWindow,
  });

  if (!result) {
    return NextResponse.json(
      { error: "INSUFFICIENT_DATA", reason: "No factor or price data available for this ticker / window." },
      { status: 422 },
    );
  }

  return NextResponse.json(result);
}
