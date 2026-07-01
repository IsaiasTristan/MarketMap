import { NextResponse, type NextRequest } from "next/server";
import { flowsExitClustersQuery } from "@/lib/api/schemas";
import { getExitClusters } from "@/server/services/institutional/institutional-query.service";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const parsed = flowsExitClustersQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const result = await getExitClusters(parsed.data.period, parsed.data.minExits);
  if (!result) return NextResponse.json({ error: "NO_DATA", reason: "No aggregates yet." }, { status: 404 });
  return NextResponse.json(result);
}
