/**
 * GET /api/analysis/securities/price-series
 *
 * Price time series for the per-stock detail chart. 1D/5D are fetched live
 * intraday from Yahoo; longer ranges come from stored daily adjusted closes.
 *
 * Query params:
 *   - ticker   required
 *   - range    1D | 5D | 1M | 6M | YTD | 1Y | 5Y | MAX  (default 1D)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getPriceSeries, type PriceRange } from "@/server/services/price-series.service";

export const maxDuration = 30;

const query = z.object({
  ticker: z.string().min(1),
  range: z
    .enum(["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"])
    .optional()
    .default("1D"),
});

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = query.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { ticker, range } = parsed.data;
  const result = await getPriceSeries(ticker, range as PriceRange);

  if (!result) {
    return NextResponse.json(
      { error: `Unknown ticker: ${ticker.toUpperCase()}` },
      { status: 404 },
    );
  }

  return NextResponse.json(result);
}
