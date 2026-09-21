import { NextResponse, type NextRequest } from "next/server";
import { pairsUniverseQuery } from "@/lib/api/schemas";
import { getPairUniverse } from "@/server/services/pairs/pairs-read.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = pairsUniverseQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const payload = await getPairUniverse(parsed.data.date);
  if (!payload) {
    return NextResponse.json({ error: "NO_DATA", reason: "No pair snapshots yet. Run job:pairs-backfill." }, { status: 404 });
  }
  return NextResponse.json(payload);
}
