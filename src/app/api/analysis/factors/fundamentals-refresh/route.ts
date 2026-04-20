import { NextResponse } from "next/server";
import { refreshPortfolioFundamentals } from "@/server/services/factor.service";

export const maxDuration = 120;

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId)
    return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
  try {
    const refreshed = await refreshPortfolioFundamentals(portfolioId);
    return NextResponse.json({ refreshed });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
