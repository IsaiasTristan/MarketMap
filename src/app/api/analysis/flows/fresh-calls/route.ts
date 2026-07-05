import { NextResponse, type NextRequest } from "next/server";
import { getFreshCalls } from "@/server/services/institutional/institutional-fresh-calls.service";

export const maxDuration = 30;

/** Fresh calls feed (FUNDS Part 3). Latest quarter; no params. */
export async function GET(_req: NextRequest) {
  const f = await getFreshCalls();
  if (!f) return NextResponse.json({ error: "NO_DATA", reason: "No aggregates yet." }, { status: 404 });
  return NextResponse.json(f);
}
