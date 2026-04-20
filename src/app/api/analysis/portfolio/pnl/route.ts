import { NextResponse } from "next/server";
import { getPositions } from "@/server/services/position.service";
import {
  getPortfolioPnl,
  getAllocationByPosition,
  getAllocationBySector,
  getAllocationByGeography,
  getContributors,
} from "@/server/services/pnl.service";

export const maxDuration = 30;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId) return NextResponse.json({ error: "portfolioId required" }, { status: 400 });

  const positions = await getPositions(portfolioId);
  const { summary, positionsWithPnl } = await getPortfolioPnl(positions);

  const allocationByPosition = getAllocationByPosition(positionsWithPnl);
  const allocationBySector = getAllocationBySector(positionsWithPnl);
  const allocationByGeography = getAllocationByGeography(positionsWithPnl);
  const { contributors, detractors } = getContributors(positionsWithPnl, 5);

  return NextResponse.json({
    summary,
    positions: positionsWithPnl,
    allocation: {
      byPosition: allocationByPosition,
      bySector: allocationBySector,
      byGeography: allocationByGeography,
    },
    contributors,
    detractors,
  });
}
