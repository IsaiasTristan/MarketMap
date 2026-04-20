/**
 * GET /api/analysis/factors/risk
 * Returns factor risk decomposition: variance, MCR, PCR, systematic/idiosyncratic split.
 */
import { NextRequest, NextResponse } from "next/server";
import { factorQueryParams } from "@/lib/api/schemas";
import { runFactorEngine } from "@/server/services/factor-engine.service";
import type { ModelPresetName } from "@/types/factors";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = factorQueryParams.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { portfolioId, model, window: win, ew } = parsed.data;
  const engineResult = await runFactorEngine({
    portfolioId,
    model: model as ModelPresetName,
    window: win,
    ewHalfLife: ew,
  });

  if (!engineResult) {
    return NextResponse.json(
      { error: "INSUFFICIENT_DATA", reason: "Not enough aligned data." },
      { status: 422 },
    );
  }

  return NextResponse.json(engineResult.risk);
}
