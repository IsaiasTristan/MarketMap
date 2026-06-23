import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { marketMapQuery } from "@/lib/api/schemas";
import { computeMarketMap } from "@/server/services/market-map.service";
import { getExtendedSnapshot } from "@/server/services/extended-hours.service";
import { getUsMarketSession } from "@/lib/market-map/market-session";
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
    extended: url.searchParams.get("extended") ?? undefined,
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

  // ALWAYS inspect the in-memory snapshot — the client needs to know
  // whether overlay data exists even when it hasn't asked for the overlay
  // yet (so it can decide whether to show the "Show after-hours" toggle
  // during a CLOSED night/weekend when the prior POST sweep is still in
  // memory). Applying the overlay is still strictly opt-in via
  // `?extended=1`.
  //
  // Defensive guard against runner lag: during REGULAR the runner clears
  // the snapshot on its next tick, but we never want the overlay to apply
  // during live regular trading regardless of what's still in memory.
  const currentSession = getUsMarketSession(new Date());
  const snap = getExtendedSnapshot();
  const snapHasData =
    !!snap &&
    (snap.session === "PRE" || snap.session === "POST") &&
    snap.quotes.size > 0 &&
    currentSession !== "REGULAR";
  const overlayActive = !!parsed.data.extended && snapHasData;
  const extendedQuotes = overlayActive ? snap!.quotes : undefined;

  const result = await computeMarketMap(
    prisma,
    id,
    parsed.data.metric as MetricKind,
    parsed.data.rowLevel as RowLevel,
    benchmark,
    { sector: parsed.data.sector, subTheme: parsed.data.subTheme },
    { extendedQuotes }
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
    extended: {
      requested: !!parsed.data.extended,
      applied: overlayActive,
      /** True when a usable extended-hours snapshot exists right now,
       *  regardless of whether the client requested the overlay. Drives
       *  the toggle's visibility during CLOSED periods so users can flip
       *  back and forth between the regular-close grid and the most
       *  recent PRE/POST snapshot. */
      available: snapHasData,
      /** Which session the snapshot was captured under — `POST` overnight
       *  after a normal trading day, `PRE` the rare case where PRE→CLOSED
       *  happened directly. Drives the toggle's label copy. */
      session: snap?.session ?? null,
      asOf: snap?.asOf ?? null,
      tickerCount: snap?.quotes.size ?? 0,
    },
  });
}
