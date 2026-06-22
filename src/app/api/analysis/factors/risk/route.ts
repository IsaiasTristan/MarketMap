/**
 * GET /api/analysis/factors/risk
 * Returns factor risk decomposition: variance, MCR, PCR, systematic/idiosyncratic split.
 */
import { NextRequest, NextResponse } from "next/server";
import { factorQueryParams } from "@/lib/api/schemas";
import { runFactorEngine } from "@/server/services/factor-engine.service";
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
  const engineResult = await runFactorEngine({
    portfolioId,
    model: model as ModelPresetName,
    window: win,
  });

  if (!engineResult) {
    return NextResponse.json(
      { error: "INSUFFICIENT_DATA", reason: "Not enough aligned data." },
      { status: 422 },
    );
  }

  // Spread `windowCoverage` onto the risk payload so the Risk tab can render
  // its discrete coverage warning chip naming holdings excluded / short on
  // data inside the trailing risk window. Additive — existing consumers
  // typed as `RiskDecomposition` simply ignore the extra field.
  return NextResponse.json({
    ...engineResult.risk,
    windowCoverage: engineResult.windowCoverage,
  });
}
