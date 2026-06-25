/**
 * GET /api/analysis/factors/top-movers
 *
 * Universe-wide per-factor movers: for each MACRO14 factor, the top-N stocks
 * most positively and most negatively driven by that factor (β × factor
 * return). The 1D horizon is computed live intraday; 5D+ are cached EOD.
 *
 * Query params:
 *   - horizon  D1 | D5 | M1 | M3 | M6 | Y1   (default D1)
 *   - mode     simple | log   (default log — ties to the popup waterfall)
 *   - window   trading days for the saved betas (default 252 / Standard)
 *   - limit    top-N per side (default 20)
 */
import { NextRequest, NextResponse } from "next/server";
import { factorTopMoversQuery } from "@/lib/api/schemas";
import { getFactorTopMovers } from "@/server/services/factor-top-movers.service";
import type { Horizon } from "@/domain/entities/horizons";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = factorTopMoversQuery.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await getFactorTopMovers({
    horizon: parsed.data.horizon as Horizon,
    mode: parsed.data.mode,
    window: parsed.data.window,
    limit: parsed.data.limit,
  });

  return NextResponse.json({ ok: true, ...result });
}
