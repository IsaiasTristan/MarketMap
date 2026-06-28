import { NextResponse, type NextRequest } from "next/server";
import { researchTrajectoryQuery } from "@/lib/api/schemas";
import { getTrajectory } from "@/server/services/revision/revision-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = researchTrajectoryQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const result = await getTrajectory(parsed.data.ticker);
  if (result.points.length === 0) {
    return NextResponse.json(
      { error: "NO_DATA", reason: `No revision history stored for ${parsed.data.ticker}.` },
      { status: 404 },
    );
  }
  return NextResponse.json(result);
}
