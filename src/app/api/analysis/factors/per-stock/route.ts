/**
 * GET /api/analysis/factors/per-stock
 *
 * Per-stock factor decomposition for every active universe constituent.
 * Returns a grid of beta / return contribution / risk contribution per
 * stock × factor, plus per-stock diagnostics and per-factor coverage.
 *
 * Query params:
 *   - model      ModelPresetName  (default MACRO14)
 *   - window     trading days     (default 378, ~1.5y)
 *   - sector     optional         (case-insensitive exact match)
 *   - subTheme   optional         (case-insensitive exact match)
 *
 * Per-row summary columns (2026-04-26):
 *   In addition to the per-factor cells, every row carries
 *   `rollingAlphaPostBurnSum` / `rollingResidualPostBurnSum` /
 *   `rollingObservationsPostBurn` — Σα_t and Σε_t computed from a
 *   fixed-`gridRollingWindow` (currently 60d) rolling OLS over the
 *   regression-aligned sample. Surfaced as the grid's `Alpha` and
 *   `Unexplained` columns; tie to the per-stock detail waterfall
 *   whenever the chart's rolling W = `gridRollingWindow`.
 */
import { NextRequest, NextResponse } from "next/server";
import { factorPerStockQuery } from "@/lib/api/schemas";
import { runPerStockFactors, describeFactors } from "@/server/services/factor-per-stock.service";
import type { ModelPresetName } from "@/types/factors";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = factorPerStockQuery.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { model, window: win, sector, subTheme } = parsed.data;
  const result = await runPerStockFactors({
    model: model as ModelPresetName,
    window: win,
    sector: sector ?? null,
    subTheme: subTheme ?? null,
  });

  if (!result) {
    return NextResponse.json(
      { error: "INSUFFICIENT_DATA", reason: "No factor return data available — refresh the factor pipeline first." },
      { status: 422 },
    );
  }

  return NextResponse.json({
    ...result,
    // Hydrate factor labels for the UI so it doesn't need its own getFactorDef call.
    factorMeta: describeFactors(result.usableFactors),
  });
}
