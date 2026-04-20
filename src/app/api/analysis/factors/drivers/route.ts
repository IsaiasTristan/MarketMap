/**
 * GET /api/analysis/factors/drivers
 * Returns holdings/sector/sub-theme factor driver breakdown.
 */
import { NextRequest, NextResponse } from "next/server";
import { factorDriversQuery } from "@/lib/api/schemas";
import { getFactorDrivers } from "@/server/services/factor-drivers.service";
import type { ModelPresetName } from "@/types/factors";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = factorDriversQuery.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { portfolioId, model, window: win, ew, groupBy } = parsed.data;
  const result = await getFactorDrivers(
    portfolioId,
    model as ModelPresetName,
    groupBy,
    win,
    ew,
  );

  if (!result) {
    return NextResponse.json(
      { error: "INSUFFICIENT_DATA", reason: "Not enough price history for position loadings." },
      { status: 422 },
    );
  }

  return NextResponse.json(result);
}
