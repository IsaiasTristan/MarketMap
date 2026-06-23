/**
 * GET /api/market/strip
 *
 * Snapshot of headline market instruments (indices, VIX, commodities, crypto,
 * FX, Treasury yields) shown in the global ticker strip under the TopBar.
 *
 * Public read-only market data — no portfolio or admin scoping. Polls Yahoo
 * directly via `getMarketStrip()` on every request; the client throttles to
 * 60s via React Query so this stays well below Yahoo's rate limits.
 */
import { NextResponse } from "next/server";
import { getMarketStrip } from "@/server/services/market-strip.service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const quotes = await getMarketStrip();
  return NextResponse.json({ quotes });
}
