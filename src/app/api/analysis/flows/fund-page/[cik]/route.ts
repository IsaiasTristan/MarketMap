import { NextResponse, type NextRequest } from "next/server";
import { getFundPage } from "@/server/services/institutional/institutional-fund-page.service";
import { FUNDS_ATTRIBUTION_CONFIG } from "@/domain/calculations/funds-attribution-config";
import { type PeerSelector } from "@/server/services/institutional/institutional-peers.service";

export const maxDuration = 30;

/** Single-fund signal-provenance page (FUNDS Part 4). `peer` selects the comparison
 *  set: MY_FUNDS (default) | CATEGORY | STYLE_TWINS | a peer-set id. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ cik: string }> }) {
  const { cik } = await ctx.params;
  if (!cik || !/\d/.test(cik)) return NextResponse.json({ error: "BAD_CIK", reason: "Invalid CIK." }, { status: 400 });

  const peerParam = req.nextUrl.searchParams.get("peer");
  let peerSel: PeerSelector | undefined;
  if (peerParam === "CATEGORY") peerSel = { mode: "CATEGORY" };
  else if (peerParam === "STYLE_TWINS") peerSel = { mode: "STYLE_TWINS" };
  else if (peerParam && peerParam !== "MY_FUNDS") peerSel = { mode: "SET", id: peerParam };
  // MY_FUNDS / null → undefined → getFundPage defaults to the seeded default set.

  const page = await getFundPage(cik, FUNDS_ATTRIBUTION_CONFIG, peerSel);
  if (!page) return NextResponse.json({ error: "NOT_FOUND", reason: "No such fund." }, { status: 404 });
  return NextResponse.json(page);
}
