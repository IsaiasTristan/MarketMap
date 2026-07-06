/**
 * GET /api/analysis/securities/valuation
 *
 * EOD enterprise-value build components + forward multiple denominators for
 * the per-stock detail popup. Cached server-side once per ET trading date per
 * ticker; the client combines these with the live intraday price.
 *
 * Query params:
 *   - ticker   required
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getValuationSnapshot } from "@/server/services/valuation.service";

export const maxDuration = 30;

const query = z.object({
  ticker: z.string().min(1),
});

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = query.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await getValuationSnapshot(parsed.data.ticker);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Valuation fetch failed" },
      { status: 502 },
    );
  }
}
