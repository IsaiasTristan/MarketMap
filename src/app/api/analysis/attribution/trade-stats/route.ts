import { NextResponse } from "next/server";
import { computeTradeStatistics } from "@/server/services/attribution.service";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId) return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
  const stats = await computeTradeStatistics(portfolioId);
  return NextResponse.json(stats);
}
