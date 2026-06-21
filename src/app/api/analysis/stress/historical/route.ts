import { NextResponse } from "next/server";
import { runHistoricalScenarios } from "@/server/services/stress.service";
import { requirePortfolioAccess } from "@/lib/api/guards";

export const maxDuration = 60;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId) return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
  const guard = await requirePortfolioAccess(req, portfolioId);
  if (guard) return guard;
  try {
    const results = await runHistoricalScenarios(portfolioId);
    return NextResponse.json(results);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
