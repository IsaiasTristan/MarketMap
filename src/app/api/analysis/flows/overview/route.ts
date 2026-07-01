import { NextResponse, type NextRequest } from "next/server";
import { flowsOverviewQuery } from "@/lib/api/schemas";
import { getOverview } from "@/server/services/institutional/institutional-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = flowsOverviewQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const result = await getOverview(parsed.data.period);
  if (!result) {
    return NextResponse.json(
      { error: "NO_DATA", reason: "No institutional aggregates computed yet. Run the ingest job." },
      { status: 404 },
    );
  }
  return NextResponse.json(result);
}
