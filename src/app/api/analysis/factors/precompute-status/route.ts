/**
 * GET /api/analysis/factors/precompute-status
 *
 * Returns the freshness verdict for the saved per-stock regression grids
 * plus the in-memory runner state. Used by the Factors UI to surface a
 * "Last saved {computedAt} — as of {asOfDate}" badge with a "Refreshing…"
 * state while a background catch-up is running.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { getPrecomputeFreshness } from "@/lib/factors/diagnostics/precompute-freshness";
import { getRunnerState } from "@/server/services/precompute-runner";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const freshness = await getPrecomputeFreshness(prisma);
    const runner = getRunnerState();
    return NextResponse.json({ freshness, runner });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
