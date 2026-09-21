import { NextResponse, type NextRequest } from "next/server";
import { pairsHedgeQuery } from "@/lib/api/schemas";
import { findHedge } from "@/server/services/pairs/hedge-finder.service";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const parsed = pairsHedgeQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { target, mode, maxNames } = parsed.data;
  const payload = await findHedge({ target, mode, maxNames });
  if (!payload) {
    return NextResponse.json(
      {
        error: "NO_DATA",
        reason: `No MACRO14 factor grid or no row for ${target}. Ensure the factor grid is precomputed (job:precompute-grid) and the ticker is in the active universe.`,
      },
      { status: 404 },
    );
  }
  return NextResponse.json(payload);
}
