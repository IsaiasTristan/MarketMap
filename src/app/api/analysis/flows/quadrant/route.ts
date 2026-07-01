import { NextResponse, type NextRequest } from "next/server";
import { flowsQuadrantQuery } from "@/lib/api/schemas";
import { getQuadrant } from "@/server/services/institutional/institutional-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = flowsQuadrantQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const result = await getQuadrant(parsed.data.period, parsed.data.minFunds);
  if (!result) return NextResponse.json({ error: "NO_DATA", reason: "No aggregates yet." }, { status: 404 });
  return NextResponse.json(result);
}
