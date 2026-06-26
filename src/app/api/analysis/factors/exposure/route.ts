/**
 * GET /api/analysis/factors/exposure
 * Returns the current factor exposure snapshot (end-of-period betas,
 * diagnostics, risk decomposition).
 *
 * Read-first: served from the precomputed FactorExposureGridSnapshot
 * (populated by the daily job + market-hours runner). A cold miss computes
 * live and writes through so the next read is warm. The snapshot-building
 * logic lives in factor-exposure-cache.service so this route and the
 * precompute produce identical payloads. Drift-snapshot persistence + alert
 * evaluation now run at the daily cadence (in the precompute), not on every
 * GET.
 */
import { NextRequest, NextResponse } from "next/server";
import { factorQueryParams } from "@/lib/api/schemas";
import { getPortfolioCoverageDiagnostics } from "@/server/services/factor-engine.service";
import {
  readFactorExposureCache,
  computeAndCacheFactorExposure,
} from "@/server/services/factor-exposure-cache.service";
import { requirePortfolioAccess } from "@/lib/api/guards";
import type { ModelPresetName } from "@/types/factors";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = factorQueryParams.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { portfolioId, model, window: win } = parsed.data;

  const guard = await requirePortfolioAccess(req, portfolioId);
  if (guard) return guard;

  const cached = await readFactorExposureCache(
    portfolioId,
    model as ModelPresetName,
    win,
  );
  if (cached) return NextResponse.json(cached);

  // Cold miss: compute live + write-through.
  const snapshot = await computeAndCacheFactorExposure(
    portfolioId,
    model as ModelPresetName,
    win,
  );
  if (!snapshot) {
    const coverage = await getPortfolioCoverageDiagnostics(portfolioId).catch(
      () => null,
    );
    return NextResponse.json(
      {
        error: "INSUFFICIENT_DATA",
        reason: "Not enough aligned portfolio + factor return data.",
        coverage,
      },
      { status: 422 },
    );
  }

  return NextResponse.json(snapshot);
}
