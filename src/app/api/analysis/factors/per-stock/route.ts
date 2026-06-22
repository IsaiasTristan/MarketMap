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
import {
  runPerStockFactors,
  describeFactors,
  type PerStockResult,
} from "@/server/services/factor-per-stock.service";
import {
  readPerStockGridCache,
  writePerStockGridCache,
} from "@/server/services/factor-per-stock-cache.service";
import type { FactorCode, ModelPresetName } from "@/types/factors";

type PeriodLabel = "1D" | "5D" | "1M" | "3M" | "6M" | "1Y";

/**
 * Overlay each row's Return / Alpha / Unexplained columns with the values
 * restricted to the requested trailing period. Betas / risk / R² / vol stay
 * on the full horizon window. Rows whose cache predates `periodSlices` are
 * left untouched (graceful degradation until the next grid rebuild).
 */
function applyPeriodOverlay(result: PerStockResult, period: PeriodLabel): PerStockResult {
  for (const row of result.rows) {
    const slice = row.periodSlices?.[period];
    if (!slice) continue;
    for (const code of Object.keys(row.cells) as FactorCode[]) {
      const cell = row.cells[code];
      if (!cell) continue;
      const v = slice.returnByFactor[code];
      if (v != null && Number.isFinite(v)) cell.returnContribution = v;
      const vLog = slice.returnByFactorLog?.[code];
      cell.returnContributionLog =
        vLog != null && Number.isFinite(vLog) ? vLog : null;
    }
    row.rollingAlphaPostBurnSum = slice.alphaSum;
    row.rollingResidualPostBurnSum = slice.residualSum;
    row.rollingAlphaPostBurnSumLog = slice.alphaSumLog;
    row.rollingResidualPostBurnSumLog = slice.residualSumLog;
    row.rollingObservationsPostBurn = slice.observations;
    // Realized total stock return over the period's date range — pure
    // price quantity that matches the price chart over the same dates.
    row.realizedTotalReturn = slice.realizedTotalReturn;
  }
  return result;
}

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = factorPerStockQuery.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { model, window: win, sector, subTheme, period } = parsed.data;
  const modelName = model as ModelPresetName;

  // Cache-first: the full-universe grid is precomputed daily and served
  // instantly. Sector/sub-theme filters bypass the cache (filtering is
  // client-side; the cache always stores the full universe). On a miss we
  // live-compute and write through so the next request is fast.
  const useCache = !sector && !subTheme;
  if (useCache) {
    const cached = await readPerStockGridCache(modelName, win);
    // Self-heal: if a period is requested but the cached grid predates the
    // periodSlices field, fall through to a fresh compute (which write-through
    // refreshes the cache) so the period overlay is correct rather than silently
    // a no-op. Without a period requested, serve the cache as-is.
    //
    // Also self-heal when the cache predates the `realizedTotalReturn` field
    // (introduced 2026-06-14) — without it the grid Total Return column
    // would render blank, so a fresh compute + write-through is needed.
    // We probe a representative row's full-window field, which the new
    // service always populates (even if null on strict-drop) and the old
    // service never sets — so `undefined` here unambiguously signals a
    // stale cache.
    const cacheHasRealized =
      cached != null &&
      cached.rows.some((r) => "realizedTotalReturn" in r);
    // Self-heal caches that predate the static-horizon-beta period
    // decomposition (2026-06-21): the new service writes a `returnByFactorLog`
    // map onto every period slice and a `returnContributionLog` onto every
    // cell. An old cache has neither, so the log-mode grid + waterfall would
    // fall back to simple silently. Probe a representative slice and force a
    // fresh compute (write-through) when it's missing.
    const cacheHasStaticBeta =
      cached != null &&
      cached.rows.some((r) =>
        r.periodSlices
          ? Object.values(r.periodSlices).some(
              (s) => s && "returnByFactorLog" in s,
            )
          : false,
      );
    const cacheUsable =
      cached != null &&
      (!period || cached.rows.some((r) => r.periodSlices)) &&
      cacheHasRealized &&
      cacheHasStaticBeta;
    if (cached && cacheUsable) {
      const overlaid = period ? applyPeriodOverlay(cached, period as PeriodLabel) : cached;
      return NextResponse.json({
        ...overlaid,
        factorMeta: describeFactors(overlaid.usableFactors),
      });
    }
  }

  const result = await runPerStockFactors({
    model: modelName,
    window: win,
    sector: sector ?? null,
    subTheme: subTheme ?? null,
  });

  if (result && useCache) {
    // Fire-and-forget write-through; don't block the response on the upsert.
    // Write the full-window result (pre-overlay) so the cache stays period-agnostic.
    writePerStockGridCache(modelName, win, result).catch(() => {});
  }

  if (!result) {
    return NextResponse.json(
      { error: "INSUFFICIENT_DATA", reason: "No factor return data available — refresh the factor pipeline first." },
      { status: 422 },
    );
  }

  const overlaid = period ? applyPeriodOverlay(result, period as PeriodLabel) : result;
  return NextResponse.json({
    ...overlaid,
    // Hydrate factor labels for the UI so it doesn't need its own getFactorDef call.
    factorMeta: describeFactors(overlaid.usableFactors),
  });
}
