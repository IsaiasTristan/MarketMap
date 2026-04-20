/**
 * GET /api/analysis/factors/exposure/history
 * Returns rolling factor beta history from FactorExposureSnapshot records.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getExposureHistory } from "@/server/services/factor-snapshot.service";

const querySchema = z.object({
  portfolioId: z.string().min(1),
  model: z.enum(["CAPM", "FF3", "CARHART4", "FF5", "EXTENDED"]).optional().default("FF5"),
  limit: z
    .string()
    .optional()
    .transform((v) => Math.max(30, Math.min(504, Number(v ?? "252"))))
    .pipe(z.number().int()),
});

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = querySchema.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { portfolioId, model, limit } = parsed.data;
  const history = await getExposureHistory(portfolioId, model, limit);
  return NextResponse.json(history);
}
