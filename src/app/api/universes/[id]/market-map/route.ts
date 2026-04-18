import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { marketMapQuery } from "@/lib/api/schemas";
import { computeMarketMap } from "@/server/services/market-map.service";
import type { BenchmarkCode, MetricKind, RowLevel } from "@/domain/entities/analytics";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import type { Horizon } from "@/domain/entities/horizons";

type Ctx = { params: Promise<{ id: string }> };

function columnRanges(
  rows: { cells: Record<Horizon, number | null> }[],
  horizons: readonly Horizon[]
) {
  const min: Record<string, number> = {};
  const max: Record<string, number> = {};
  for (const h of horizons) {
    const vals = rows
      .map((r) => r.cells[h])
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (vals.length === 0) {
      min[h] = 0;
      max[h] = 0;
    } else {
      min[h] = Math.min(...vals);
      max[h] = Math.max(...vals);
    }
  }
  return { min, max };
}

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const raw = {
    metric: url.searchParams.get("metric") ?? "RETURN",
    rowLevel: url.searchParams.get("rowLevel") ?? "SECTOR",
    benchmark: url.searchParams.get("benchmark") ?? "SP500",
    sector: url.searchParams.get("sector") ?? undefined,
    subTheme: url.searchParams.get("subTheme") ?? undefined,
  };
  const parsed = marketMapQuery.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, errors: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const exists = await prisma.universe.findUnique({ where: { id } });
  if (!exists) return NextResponse.json({ error: "Universe not found" }, { status: 404 });

  const benchmark = (parsed.data.benchmark ?? "SP500") as BenchmarkCode;
  const result = await computeMarketMap(
    prisma,
    id,
    parsed.data.metric as MetricKind,
    parsed.data.rowLevel as RowLevel,
    benchmark,
    { sector: parsed.data.sector, subTheme: parsed.data.subTheme }
  );
  const ranges = columnRanges(result.rows, HORIZON_ORDER);
  return NextResponse.json({
    ok: true,
    metric: parsed.data.metric,
    rowLevel: parsed.data.rowLevel,
    benchmark,
    asOf: result.asOf,
    warnings: result.warnings,
    horizons: HORIZON_ORDER,
    columnRanges: ranges,
    rows: result.rows,
  });
}
