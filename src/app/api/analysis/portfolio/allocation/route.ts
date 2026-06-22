import { NextResponse } from "next/server";
import {
  getReturnRiskAllocation,
  ALLOCATION_HORIZONS,
  type AllocationHorizon,
} from "@/server/services/pnl.service";
import { requirePortfolioAccess } from "@/lib/api/guards";

export const maxDuration = 30;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId) {
    return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
  }

  const horizonParam = (searchParams.get("horizon") ?? "1D") as AllocationHorizon;
  if (!ALLOCATION_HORIZONS.includes(horizonParam)) {
    return NextResponse.json(
      {
        error: `invalid horizon "${horizonParam}" — must be one of ${ALLOCATION_HORIZONS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const guard = await requirePortfolioAccess(req, portfolioId);
  if (guard) return guard;

  try {
    const result = await getReturnRiskAllocation(portfolioId, horizonParam);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
