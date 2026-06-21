import { NextResponse } from "next/server";
import { refreshPortfolioFundamentals } from "@/server/services/factor.service";
import { requirePortfolioAccess } from "@/lib/api/guards";

export const maxDuration = 120;

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId)
    return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
  const guard = await requirePortfolioAccess(req, portfolioId);
  if (guard) return guard;
  try {
    const refreshed = await refreshPortfolioFundamentals(portfolioId);
    return NextResponse.json({ refreshed });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
