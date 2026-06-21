import { NextResponse } from "next/server";
import { computeFactorExposures } from "@/server/services/factor.service";
import { requirePortfolioAccess } from "@/lib/api/guards";

export const maxDuration = 30;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId) return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
  const guard = await requirePortfolioAccess(req, portfolioId);
  if (guard) return guard;
  try {
    const result = await computeFactorExposures(portfolioId);
    if (!result) return NextResponse.json({ error: "No positions found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
