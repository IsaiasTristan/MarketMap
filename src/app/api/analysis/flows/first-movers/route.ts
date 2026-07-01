import { NextResponse, type NextRequest } from "next/server";
import { flowsFirstMoversQuery } from "@/lib/api/schemas";
import { getFirstMovers } from "@/server/services/institutional/institutional-query.service";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const parsed = flowsFirstMoversQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const result = await getFirstMovers(parsed.data.period, parsed.data.broadThreshold);
  if (!result) return NextResponse.json({ error: "NO_DATA", reason: "No aggregates yet." }, { status: 404 });
  return NextResponse.json(result);
}
