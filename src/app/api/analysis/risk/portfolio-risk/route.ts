import { NextResponse } from "next/server";
import { computePortfolioRisk, computePortfolioRiskSeries } from "@/server/services/risk.service";

export const maxDuration = 30;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId) return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
  try {
    const [risk, series] = await Promise.all([
      computePortfolioRisk(portfolioId),
      computePortfolioRiskSeries(portfolioId),
    ]);
    return NextResponse.json({ risk, series });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
