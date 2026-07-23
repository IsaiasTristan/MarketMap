/**
 * GET /api/market/strip
 *
 * Snapshot of headline market instruments (indices, VIX, commodities, crypto,
 * FX, Treasury yields) shown in the global ticker strip under the TopBar.
 *
 * Public read-only market data — no portfolio or admin scoping. Served from a
 * stale-while-revalidate cache (`getMarketStripCached`) that refreshes Yahoo in
 * the background under a single-flight guard and serves the last good value on
 * a throttle, so the strip never blocks or blanks after its first fill.
 */
import { NextResponse } from "next/server";
import { getMarketStripCached } from "@/server/services/market-strip.service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const quotes = await getMarketStripCached();
  return NextResponse.json({ quotes });
}
