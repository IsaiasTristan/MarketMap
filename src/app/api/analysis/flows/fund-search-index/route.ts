import { NextResponse } from "next/server";
import { getFundSearchIndex } from "@/server/services/institutional/institutional-search.service";

export const maxDuration = 30;

/** The client-shippable fund search index (Fund Overview Part 6): one payload, matched
 *  in the browser by the pure fund-search matcher — no per-keystroke round-trip. */
export async function GET() {
  const index = await getFundSearchIndex();
  return NextResponse.json({ funds: index });
}
