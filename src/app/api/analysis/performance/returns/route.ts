import { NextResponse } from "next/server";
import { computePerformanceSeries } from "@/server/services/performance.service";

export const maxDuration = 60;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  const benchmark = (searchParams.get("benchmark") as "SP500" | "NASDAQ" | "DOW") ?? "SP500";

  if (!portfolioId) return NextResponse.json({ error: "portfolioId required" }, { status: 400 });

  try {
    const series = await computePerformanceSeries(portfolioId, benchmark);
    if (!series) return NextResponse.json({ error: "Insufficient data" }, { status: 422 });
    return NextResponse.json(series);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
