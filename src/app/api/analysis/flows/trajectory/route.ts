import { NextResponse, type NextRequest } from "next/server";
import { flowsTrajectoryQuery } from "@/lib/api/schemas";
import { getTrajectory } from "@/server/services/institutional/institutional-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = flowsTrajectoryQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const result = await getTrajectory(parsed.data.ticker);
  if (result.points.length === 0) {
    return NextResponse.json(
      { error: "NO_DATA", reason: `No institutional history for ${parsed.data.ticker}.` },
      { status: 404 },
    );
  }
  return NextResponse.json(result);
}
