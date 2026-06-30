import { NextRequest, NextResponse } from "next/server";
import { portfolioNewsQuery } from "@/lib/api/schemas";
import { getPortfolioNews } from "@/server/services/portfolio-news.service";
import { requirePortfolioAccess } from "@/lib/api/guards";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = portfolioNewsQuery.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { portfolioId, limit } = parsed.data;

  const guard = await requirePortfolioAccess(req, portfolioId);
  if (guard) return guard;

  try {
    const result = await getPortfolioNews(portfolioId, limit);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
