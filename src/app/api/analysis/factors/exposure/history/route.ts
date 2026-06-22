/**
 * GET /api/analysis/factors/exposure/history
 *
 * Returns the rolling factor-beta history that powers the "Rolling Factor
 * Betas" chart. Cache-first: serves the daily-precomputed
 * FactorRollingBetaSnapshot for (portfolioId, model, window); on a miss it
 * live-computes the rolling OLS series via the engine and writes through.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MODEL_PRESET_NAMES } from "@/lib/api/schemas";
import { requirePortfolioAccess } from "@/lib/api/guards";
import { runFactorEngine } from "@/server/services/factor-engine.service";
import {
  buildRollingBetaSeries,
  readRollingBetaCache,
  writeRollingBetaCache,
  type RollingBetaSeries,
} from "@/server/services/factor-rolling-cache.service";
import type { ModelPresetName } from "@/types/factors";

export const maxDuration = 60;

const querySchema = z.object({
  portfolioId: z.string().min(1),
  model: z.enum(MODEL_PRESET_NAMES).optional().default("MACRO14"),
  window: z
    .string()
    .optional()
    .transform((v) => Math.max(20, Math.min(2520, Number(v ?? "252"))))
    .pipe(z.number().int()),
  limit: z
    .string()
    .optional()
    .transform((v) => Math.max(30, Math.min(756, Number(v ?? "252"))))
    .pipe(z.number().int()),
});

/** Return only the trailing `limit` points of a rolling-beta series. */
function sliceTrailing(series: RollingBetaSeries, limit: number): RollingBetaSeries {
  if (series.dates.length <= limit) return series;
  const start = series.dates.length - limit;
  const slicedSeries: Record<string, number[]> = {};
  for (const [code, values] of Object.entries(series.series)) {
    slicedSeries[code] = values.slice(start);
  }
  return {
    dates: series.dates.slice(start),
    series: slicedSeries,
    alphas: series.alphas.slice(start),
    rSquareds: series.rSquareds.slice(start),
    asOfDate: series.asOfDate,
  };
}

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = querySchema.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { portfolioId, model, window: win, limit } = parsed.data;
  const guard = await requirePortfolioAccess(req, portfolioId);
  if (guard) return guard;

  // Cache-first.
  const cached = await readRollingBetaCache(portfolioId, model as ModelPresetName, win);
  if (cached) {
    return NextResponse.json(sliceTrailing(cached, limit));
  }

  // Miss — live-compute the rolling series and write through.
  const engineResult = await runFactorEngine({
    portfolioId,
    model: model as ModelPresetName,
    window: win,
  });
  if (!engineResult) {
    return NextResponse.json(
      { dates: [], series: {}, alphas: [], rSquareds: [], asOfDate: null } satisfies RollingBetaSeries,
    );
  }

  const series = buildRollingBetaSeries(engineResult);
  writeRollingBetaCache(portfolioId, model as ModelPresetName, win, series).catch(() => {});
  return NextResponse.json(sliceTrailing(series, limit));
}
