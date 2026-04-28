/**
 * GET /api/analysis/portfolio/weights?portfolioId=...
 *
 * Returns the portfolio's positions with derived gross + signed weights at
 * the latest available price. Single source of truth for the front-end —
 * any view that needs to know "what fraction of the portfolio is X, and is
 * it long or short" reads from here.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { loadPortfolioWeights } from "@/server/services/portfolio.service";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId) {
    return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
  }
  const weights = await loadPortfolioWeights(prisma, portfolioId);
  return NextResponse.json({ weights });
}
