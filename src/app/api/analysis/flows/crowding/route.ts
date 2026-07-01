import { NextResponse, type NextRequest } from "next/server";
import { flowsCrowdingQuery } from "@/lib/api/schemas";
import { getCrowdingColumn } from "@/server/services/institutional/institutional-query.service";

export const maxDuration = 30;

/**
 * Triangulation hook: Engine 3 crowding exposed as ONE standalone column for the
 * later three-engine overlay. Never merged into a composite — callers align it
 * beside Engine 1/2 signals themselves.
 */
export async function GET(req: NextRequest) {
  const parsed = flowsCrowdingQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const result = await getCrowdingColumn(parsed.data.tickers, parsed.data.period);
  if (!result) return NextResponse.json({ error: "NO_DATA", reason: "No aggregates yet." }, { status: 404 });
  return NextResponse.json(result);
}
