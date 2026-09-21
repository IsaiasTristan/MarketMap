import { NextResponse, type NextRequest } from "next/server";
import { pairsRankQuery } from "@/lib/api/schemas";
import { getPairRank } from "@/server/services/pairs/pairs-read.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = pairsRankQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { date, weighting, tier, scope, minHedgeEff, driver, sector, limit } = parsed.data;
  const payload = await getPairRank({ date, weighting, tier, scope, minHedgeEff, driver, sector, limit });
  if (!payload) {
    return NextResponse.json({ error: "NO_DATA", reason: "No pair snapshots yet. Run job:pairs-backfill." }, { status: 404 });
  }
  return NextResponse.json(payload);
}
