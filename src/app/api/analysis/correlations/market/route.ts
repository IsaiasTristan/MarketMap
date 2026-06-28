/**
 * GET /api/analysis/correlations/market
 * Returns Sector and Sub-Theme price-performance correlation matrices for the
 * active universe over the requested trading-day window (1M/3M/6M/1Y).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { marketCorrelationQuery } from "@/lib/api/schemas";
import { getMarketCorrelations } from "@/server/services/price-correlation.service";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = marketCorrelationQuery.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await getMarketCorrelations(prisma, parsed.data.window);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[GET /api/analysis/correlations/market]", e);
    return NextResponse.json(
      { error: message || "Failed to compute market correlations." },
      { status: 503 },
    );
  }
}
