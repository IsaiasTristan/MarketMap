/**
 * GET /api/analysis/factors/attribution/live-1d
 *
 * Lightweight live 1D portfolio decomposition for polling. Reuses cached
 * horizon end-fit betas (2min TTL) and fetches only Yahoo live quotes.
 */
import { NextRequest, NextResponse } from "next/server";
import { factorQueryParams } from "@/lib/api/schemas";
import { requirePortfolioAccess } from "@/lib/api/guards";
import { computeLivePortfolio1D } from "@/server/services/live-portfolio-1d.service";
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

  const result = await computeLivePortfolio1D(
    portfolioId,
    model as ModelPresetName,
    win,
  );

  if (!result.ok) {
    return NextResponse.json({ live: false, reason: result.reason });
  }

  return NextResponse.json({
    live: true,
    summary: result.summary,
    summaryLog: result.summaryLog,
    live1D: result.live1D,
  });
}
