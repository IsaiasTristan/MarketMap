/**
 * GET /api/analysis/factors/alerts
 * Returns current factor-related alerts for a portfolio.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getFactorAlerts } from "@/server/services/factor-alerts.service";
import { requirePortfolioAccess } from "@/lib/api/guards";

const querySchema = z.object({ portfolioId: z.string().min(1) });

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = querySchema.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const guard = await requirePortfolioAccess(req, parsed.data.portfolioId);
  if (guard) return guard;
  const alerts = await getFactorAlerts(parsed.data.portfolioId);
  return NextResponse.json(alerts);
}
