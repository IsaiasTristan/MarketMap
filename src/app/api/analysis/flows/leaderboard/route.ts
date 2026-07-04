import { NextResponse, type NextRequest } from "next/server";
import { flowsLeaderboardQuery } from "@/lib/api/schemas";
import { getLeaderboard } from "@/server/services/institutional/institutional-leaderboard.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = flowsLeaderboardQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const result = await getLeaderboard(parsed.data.period);
  if (!result) return NextResponse.json({ error: "NO_DATA", reason: "No aggregates yet." }, { status: 404 });
  return NextResponse.json(result);
}
