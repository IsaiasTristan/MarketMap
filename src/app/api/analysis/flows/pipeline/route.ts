import { NextResponse, type NextRequest } from "next/server";
import { flowsPipelineQuery } from "@/lib/api/schemas";
import { getTrajectoryPipeline } from "@/server/services/institutional/institutional-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = flowsPipelineQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const result = await getTrajectoryPipeline(parsed.data.period, parsed.data.limit, parsed.data.cap);
  if (!result) return NextResponse.json({ error: "NO_DATA", reason: "No aggregates yet." }, { status: 404 });
  return NextResponse.json(result);
}
