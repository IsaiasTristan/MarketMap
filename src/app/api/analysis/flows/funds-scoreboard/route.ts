import { NextResponse, type NextRequest } from "next/server";
import { getFollowScoreboard } from "@/server/services/institutional/institutional-follow.service";

export const maxDuration = 30;

/** Originator scoreboard (FUNDS Part 1). Latest quarter; no params. */
export async function GET(_req: NextRequest) {
  const sb = await getFollowScoreboard();
  if (!sb) return NextResponse.json({ error: "NO_DATA", reason: "No aggregates yet." }, { status: 404 });
  // Serializable projection: drop the outcome Map + the large initiations array.
  return NextResponse.json({ filingPeriod: sb.filingPeriod, cohortMedianRate: sb.cohortMedianRate, rows: sb.rows });
}
