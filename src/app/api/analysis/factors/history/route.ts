import { NextResponse } from "next/server";
import { prisma as db } from "@/infrastructure/db/client";
import { requirePortfolioAccess } from "@/lib/api/guards";

export const maxDuration = 30;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId) return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
  const guard = await requirePortfolioAccess(req, portfolioId);
  if (guard) return guard;

  // Return the stored factor snapshot history if available
  const snapshots = await db.factorExposureSnapshot.findMany({
    where: { portfolioId },
    orderBy: { asOfDate: "asc" },
    take: 252,
  });

  if (!snapshots.length) {
    return NextResponse.json({ dates: [], series: {} });
  }

  const dates = snapshots.map((s) => s.asOfDate.toISOString().slice(0, 10));
  const factorKeys = ["marketBeta", "sizeFactor", "valueFactor", "momentumFactor", "qualityFactor", "lowVolFactor"];
  const series: Record<string, number[]> = {};
  for (const key of factorKeys) {
    series[key] = snapshots.map((s) => {
      const f = s.factorsJson as Record<string, number>;
      return f[key] ?? 0;
    });
  }

  return NextResponse.json({ dates, series });
}
