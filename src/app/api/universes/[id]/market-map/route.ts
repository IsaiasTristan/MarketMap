import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { marketMapQuery } from "@/lib/api/schemas";
import { computeMarketMap } from "@/server/services/market-map.service";
import {
  readMarketMapCache,
  computeAndCacheMarketMap,
} from "@/server/services/market-map-cache.service";
import { getExtendedSnapshot } from "@/server/services/extended-hours.service";
import { getLiveRegularSnapshot } from "@/server/services/live-regular.service";
import { getUsMarketSession } from "@/lib/market-map/market-session";
import type { LiveOverlayMode } from "@/server/services/market-map.service";
import type { BenchmarkCode, MetricKind, RowLevel } from "@/domain/entities/analytics";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import { percentileColumnRanges } from "@/domain/calculations/percentile-range";

type Ctx = { params: Promise<{ id: string }> };

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

  // Live regular-session overlay. During REGULAR the cache fast path is already
  // overlaid by the regular-hours runner, so this is only applied on the
  // non-cacheable live-compute branches (filtered / non-COMPANY). Extended
  // (PRE/POST) overlay takes precedence when active. After close the frozen
  // snapshot keeps today's regular move visible until the daily job lands.
  const liveSnap = getLiveRegularSnapshot();
  const liveActive = !overlayActive && liveSnap.quotes.size > 0;
  const liveMode: LiveOverlayMode =
    currentSession === "REGULAR" ? "live" : "frozen";
  const liveQuotes = liveActive ? liveSnap.quotes : undefined;

  const metric = parsed.data.metric as MetricKind;
  const rowLevel = parsed.data.rowLevel as RowLevel;

  // Fast path: COMPANY grid with no extended overlay and no sector/sub-theme
  // filter is served from the precomputed snapshot (sub-second). A cold miss
  // computes live + writes through so the next read is warm. The overlay and
  // filtered/non-COMPANY paths are inherently dynamic and always compute live.
  const cacheable =
    !overlayActive &&
    !parsed.data.sector &&
    !parsed.data.subTheme &&
    rowLevel === "COMPANY";

  let rows;
  let asOf: string | null;
  let warnings: string[];
  let ranges: { min: Record<string, number>; max: Record<string, number> };

  if (cacheable) {
    const cached =
      (await readMarketMapCache(id, metric, benchmark)) ??
      (await computeAndCacheMarketMap(id, metric, benchmark));
    rows = cached.rows;
    asOf = cached.asOf;
    warnings = cached.warnings;
    ranges = cached.columnRanges;
  } else {
    const result = await computeMarketMap(
      prisma,
      id,
      metric,
      rowLevel,
      benchmark,
      { sector: parsed.data.sector, subTheme: parsed.data.subTheme },
      { extendedQuotes, liveQuotes, liveMode }
    );
    rows = result.rows;
    asOf = result.asOf;
    warnings = result.warnings;
    // Winsorized (p5/p95) span so a few extreme stocks don't compress the heat
    // scale and wash out the rest of the grid. Shared by the grid, Top Movers,
    // and Factor Top Movers (all keyed off this company-level range).
    ranges = percentileColumnRanges(result.rows, HORIZON_ORDER);
  }

  return NextResponse.json({
    ok: true,
    metric: parsed.data.metric,
    rowLevel: parsed.data.rowLevel,
    benchmark,
    asOf,
    warnings,
    horizons: HORIZON_ORDER,
    columnRanges: ranges,
    rows,
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
    /** Live regular-session overlay status (ops / early-warning). `applied`
     *  reflects whether live data is serving this grid — via the overlaid
     *  cache on the COMPANY fast path during REGULAR, or via the live-compute
     *  branch otherwise. `servedVia` surfaces which upstream path fed the
     *  snapshot (spark today) so a Yahoo lockdown is visible immediately. */
    live: {
      applied: liveActive,
      mode: liveActive ? liveMode : null,
      asOf: liveSnap.asOf,
      tickerCount: liveSnap.quotes.size,
      servedVia: liveSnap.servedVia,
    },
  });
}
