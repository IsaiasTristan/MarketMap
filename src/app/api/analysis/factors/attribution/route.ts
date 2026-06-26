/**
 * GET /api/analysis/factors/attribution
 * Returns factor return attribution (daily, cumulative, period summaries).
 */
import { NextRequest, NextResponse } from "next/server";
import { factorQueryParams } from "@/lib/api/schemas";
import {
  readFactorAttributionCache,
  computeAndCacheFactorAttribution,
} from "@/server/services/factor-attribution-cache.service";
import { requirePortfolioAccess } from "@/lib/api/guards";
import type { ModelPresetName } from "@/types/factors";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = factorQueryParams.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { portfolioId, model, window: win } = parsed.data;
  const guard = await requirePortfolioAccess(req, portfolioId);
  if (guard) return guard;

  // Read-first from the precomputed snapshot; cold miss computes + writes through.
  const result =
    (await readFactorAttributionCache(portfolioId, model as ModelPresetName, win)) ??
    (await computeAndCacheFactorAttribution(portfolioId, model as ModelPresetName, win));

  if (!result) {
    return NextResponse.json(
      { error: "INSUFFICIENT_DATA", reason: "Need at least 2×k+30 aligned trading days." },
      { status: 422 },
    );
  }

  return NextResponse.json(result);
}
