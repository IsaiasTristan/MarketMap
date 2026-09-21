import { NextResponse, type NextRequest } from "next/server";
import { pairsMatrixQuery } from "@/lib/api/schemas";
import { getPairMatrix } from "@/server/services/pairs/pairs-read.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = pairsMatrixQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { date, weighting, sector, groupType } = parsed.data;
  const payload = await getPairMatrix(date, weighting, sector, groupType);
  if (!payload) {
    return NextResponse.json({ error: "NO_DATA", reason: "No pair snapshots yet. Run job:pairs-backfill." }, { status: 404 });
  }
  return NextResponse.json(payload);
}
