import { NextResponse, type NextRequest } from "next/server";
import { pairsTier2Query } from "@/lib/api/schemas";
import { getPairTier2 } from "@/server/services/pairs/pairs-read.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = pairsTier2Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { date, weighting, subsector, engine } = parsed.data;
  const payload = await getPairTier2({ date, weighting, subsector, engine });
  if (!payload) {
    return NextResponse.json({ error: "NO_DATA", reason: "No Tier-2 snapshots yet. Run job:pairs-backfill." }, { status: 404 });
  }
  return NextResponse.json(payload);
}
