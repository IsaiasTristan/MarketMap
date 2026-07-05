import { NextResponse, type NextRequest } from "next/server";
import { getFollowScoreboard } from "@/server/services/institutional/institutional-follow.service";
import { getExitLeadBoard } from "@/server/services/institutional/institutional-exit-lead.service";

export const maxDuration = 30;

/** Originator scoreboard (FUNDS Part 1). Latest quarter; no params.
 *  Merges each fund's exit-lead rate (Part 2) so the scoreboard's EXIT-LEAD column
 *  is populated (mockup parity). */
export async function GET(_req: NextRequest) {
  const [sb, xb] = await Promise.all([getFollowScoreboard(), getExitLeadBoard()]);
  if (!sb) return NextResponse.json({ error: "NO_DATA", reason: "No aggregates yet." }, { status: 404 });
  const exitByFund = new Map((xb?.rows ?? []).map((r) => [r.fundId, r]));
  const rows = sb.rows.map((r) => {
    const x = exitByFund.get(r.fundId);
    return { ...r, exitLeadRate: x?.rateSufficient ? x.exitLeadRate : null, exitLeadN: x?.n ?? 0 };
  });
  // Serializable projection: drop the outcome Map + the large initiations array.
  return NextResponse.json({ filingPeriod: sb.filingPeriod, cohortMedianRate: sb.cohortMedianRate, rows });
}
