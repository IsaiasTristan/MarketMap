/**
 * GET /api/analysis/factors/market
 * Returns factor market context: per-factor performance stats and correlation matrix.
 */
import { NextRequest, NextResponse } from "next/server";
import { factorMarketQuery } from "@/lib/api/schemas";
import { getFactorMarketContext } from "@/server/services/factor-market.service";
import type { ModelPresetName } from "@/types/factors";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = factorMarketQuery.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const context = await getFactorMarketContext({
    corrWindow: parsed.data.corrWindow,
    model: parsed.data.model as ModelPresetName | undefined,
  });
  return NextResponse.json(context);
}
