/**
 * POST /api/analysis/factors/per-stock/precompute
 *
 * Recomputes and caches the per-stock factor grid for every UI-visible
 * (model, window) combination. Backs the manual "Rebuild cache" button in the
 * Factors toolbar and the daily pre-open CLI job. The Per-Stock GET route then
 * serves these cached grids instantly.
 */
import { NextResponse } from "next/server";
import { precomputeAllPerStockGrids } from "@/server/services/factor-per-stock-cache.service";
import { requireAdminGuard } from "@/lib/api/guards";

// Generous budget — each (model, window) grid runs the full per-stock
// regression pipeline (~tens of seconds on a ~400-ticker universe).
export const maxDuration = 300;

export async function POST(req: Request) {
  const adminGuard = await requireAdminGuard(req);
  if (adminGuard) return adminGuard;
  try {
    const summary = await precomputeAllPerStockGrids();
    return NextResponse.json(summary);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
