import { NextResponse } from "next/server";
import { computePerformanceMetrics } from "@/server/services/performance.service";
import { requirePortfolioAccess } from "@/lib/api/guards";

export const maxDuration = 60;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  const benchmark = (searchParams.get("benchmark") as "SP500" | "NASDAQ" | "DOW") ?? "SP500";

  if (!portfolioId) return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
  const guard = await requirePortfolioAccess(req, portfolioId);
  if (guard) return guard;

  try {
    const metrics = await computePerformanceMetrics(portfolioId, benchmark);
    if (!metrics) return NextResponse.json({ error: "Insufficient data (need ≥63 trading days)" }, { status: 422 });
    return NextResponse.json(metrics);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
