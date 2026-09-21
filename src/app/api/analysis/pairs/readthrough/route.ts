import { NextResponse, type NextRequest } from "next/server";
import { pairsReadThroughQuery } from "@/lib/api/schemas";
import { getPairReadThroughs } from "@/server/services/pairs/pairs-read.service";

export const maxDuration = 30;

/** Tier 3 read-through panel — latest state per active curated link. */
export async function GET(req: NextRequest) {
  const parsed = pairsReadThroughQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  return NextResponse.json(await getPairReadThroughs(parsed.data.date));
}
