/**
 * commodities.service — read side of the COMMODITIES tab. Serves registry,
 * vintages (with basis→outright transform), analytics boards, and the
 * futures-only export table from FuturesCurveSnapshot reads + pure
 * lib/commodities math. No vendor calls here; ingest owns writes.
 */
import { prisma } from "@/infrastructure/db/client";
import { mergeHistoryAndStrip } from "@/lib/commodities/bridge";
import { shortDate } from "@/lib/commodities/format";
import { toOutright } from "@/lib/commodities/outright";
import { gasSeasonality } from "@/lib/commodities/seasonality";
import { balStrip, calStrip, rollingStrip, stripAvgByIndex, stripDelta } from "@/lib/commodities/strips";
import { curveStructure } from "@/lib/commodities/structure";
import { TENOR_DEFS, tenorColumns, tenorValues } from "@/lib/commodities/tenors";
import { resolveVintages } from "@/lib/commodities/vintages";
import type {
  BasisMode,
  BridgePoint,
  CurveAnalyticsDto,
  CurveInfoDto,
  CurvePoint,
  CurveVintagesDto,
  ExportTableDto,
  HistoryMonthDto,
  ResolvedVintage,
  StripBoardRow,
  VintageDeltaRow,
  VintageId,
  VintageSeries,
} from "@/types/commodities";

function isoFromDb(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pointsFromJson(json: unknown): CurvePoint[] {
  if (!Array.isArray(json)) return [];
  return (json as CurvePoint[]).filter(
    (p) => p && typeof p.contractMonth === "string" && Number.isFinite(p.price),
  );
}

type CurveRow = NonNullable<Awaited<ReturnType<typeof findCurve>>>;

async function findCurve(code: string) {
  return prisma.commodityCurve.findUnique({
    where: { code },
    include: { benchCurve: { select: { id: true, code: true, name: true } } },
  });
}

/** Snapshot points at the exact settle date (already resolved). */
async function snapshotPoints(curveId: string, settleIso: string): Promise<CurvePoint[]> {
  const row = await prisma.futuresCurveSnapshot.findUnique({
    where: { curveId_settleDate: { curveId, settleDate: new Date(`${settleIso}T00:00:00.000Z`) } },
    select: { points: true },
  });
  return row ? pointsFromJson(row.points) : [];
}

/** Nearest snapshot at/before `targetIso` for a curve (bench alignment). */
async function nearestSnapshotAtOrBefore(
  curveId: string,
  targetIso: string,
): Promise<{ settleIso: string; points: CurvePoint[] } | null> {
  const row = await prisma.futuresCurveSnapshot.findFirst({
    where: { curveId, settleDate: { lte: new Date(`${targetIso}T00:00:00.000Z`) } },
    orderBy: { settleDate: "desc" },
    select: { settleDate: true, points: true },
  });
  return row ? { settleIso: isoFromDb(row.settleDate), points: pointsFromJson(row.points) } : null;
}

/**
 * Apply basis mode: DIFF (or a FLAT curve) returns the strip as stored;
 * OUT on a BASIS curve adds the bench strip as of the same (nearest ≤) date.
 */
async function applyBasisMode(
  curve: CurveRow,
  points: CurvePoint[],
  settleIso: string,
  basisMode: BasisMode,
): Promise<CurvePoint[]> {
  if (curve.kind !== "BASIS" || basisMode !== "OUT" || !curve.benchCurve) return points;
  const bench = await nearestSnapshotAtOrBefore(curve.benchCurve.id, settleIso);
  return bench ? toOutright(points, bench.points) : [];
}

// ─── registry ────────────────────────────────────────────────────────────────

export async function getCurveRegistry(): Promise<CurveInfoDto[]> {
  // The registry now spans the full imported AEGIS catalog (~455 rows), so
  // latest-prompt lookups are restricted to ACTIVE curves (the only ones the
  // daily ingest snapshots) — inactive directory entries serve null prompts.
  const curves = await prisma.commodityCurve.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { benchCurve: { select: { code: true } } },
  });
  const out: CurveInfoDto[] = [];
  for (const c of curves) {
    let latestPrompt: number | null = null;
    let latestSettleDate: string | null = null;
    if (c.isActive) {
      const latest = await prisma.futuresCurveSnapshot.findFirst({
        where: { curveId: c.id },
        orderBy: { settleDate: "desc" },
        select: { settleDate: true, points: true },
      });
      if (latest) {
        latestPrompt = pointsFromJson(latest.points)[0]?.price ?? null;
        latestSettleDate = isoFromDb(latest.settleDate);
      }
    }
    out.push({
      code: c.code,
      name: c.name,
      group: c.group,
      kind: c.kind,
      unit: c.unit,
      decimals: c.decimals,
      benchCode: c.benchCurve?.code ?? null,
      product: c.product,
      isActive: c.isActive,
      sortOrder: c.sortOrder,
      latestPrompt,
      latestSettleDate,
    });
  }
  return out;
}

// ─── vintages ───────────────────────────────────────────────────────────────

/** Shared loader: latest strip + resolved vintages, basis mode applied. */
async function loadCurveState(curve: CurveRow, basisMode: BasisMode) {
  const settleDates = (
    await prisma.futuresCurveSnapshot.findMany({
      where: { curveId: curve.id },
      select: { settleDate: true },
      orderBy: { settleDate: "asc" },
    })
  ).map((r) => isoFromDb(r.settleDate));
  if (settleDates.length === 0) return null;

  const latestSettle = settleDates[settleDates.length - 1]!;
  const latestRaw = await snapshotPoints(curve.id, latestSettle);
  const latest = await applyBasisMode(curve, latestRaw, latestSettle, basisMode);
  const resolved = resolveVintages(latestSettle, settleDates);

  return { settleDates, latestSettle, latest, resolved, snapshotCount: settleDates.length };
}

async function loadVintageSeries(
  curve: CurveRow,
  resolved: ResolvedVintage[],
  ids: VintageId[],
  basisMode: BasisMode,
): Promise<VintageSeries[]> {
  const out: VintageSeries[] = [];
  for (const r of resolved) {
    if (!ids.includes(r.id) || r.resolvedDate === null) continue;
    const raw = await snapshotPoints(curve.id, r.resolvedDate);
    const points = await applyBasisMode(curve, raw, r.resolvedDate, basisMode);
    if (points.length > 0) out.push({ id: r.id, resolvedDate: r.resolvedDate, points });
  }
  return out;
}

async function loadHistory(
  curve: CurveRow,
  months: number,
  basisMode: BasisMode,
): Promise<HistoryMonthDto[]> {
  if (months <= 0) return [];
  const rows = await prisma.commodityHistoryMonthly.findMany({
    where: { curveId: curve.id },
    orderBy: { month: "desc" },
    take: months,
  });
  let history = rows
    .map((r) => ({ month: r.month, avgSettle: r.avgSettle }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));

  // Outright mode on a basis curve: realized outright = realized diff + bench
  // realized, joined by month (months missing on either side drop out).
  if (curve.kind === "BASIS" && basisMode === "OUT" && curve.benchCurve) {
    const benchRows = await prisma.commodityHistoryMonthly.findMany({
      where: { curveId: curve.benchCurve.id, month: { in: history.map((h) => h.month) } },
    });
    const benchByMonth = new Map(benchRows.map((r) => [r.month, r.avgSettle]));
    history = history
      .filter((h) => benchByMonth.has(h.month))
      .map((h) => ({ month: h.month, avgSettle: h.avgSettle + benchByMonth.get(h.month)! }));
  }
  return history;
}

export async function getCurveVintages(
  code: string,
  opts: { ids: VintageId[]; basisMode: BasisMode; history: number },
): Promise<CurveVintagesDto | null> {
  const curve = await findCurve(code);
  if (!curve || !curve.isActive) return null;
  const state = await loadCurveState(curve, opts.basisMode);
  if (!state) return null;

  const vintages = await loadVintageSeries(curve, state.resolved, opts.ids, opts.basisMode);
  const history = await loadHistory(curve, opts.history, opts.basisMode);

  return {
    code: curve.code,
    name: curve.name,
    kind: curve.kind,
    unit: curve.unit,
    decimals: curve.decimals,
    basisMode: opts.basisMode,
    benchCode: curve.benchCurve?.code ?? null,
    latestSettleDate: state.latestSettle,
    latest: state.latest,
    vintages,
    resolved: state.resolved,
    history,
    snapshotCount: state.snapshotCount,
  };
}

/** History+strip bridge series (used by the data-table export path). */
export function buildBridge(
  history: HistoryMonthDto[],
  latest: CurvePoint[],
  latestSettleIso: string,
): BridgePoint[] {
  return mergeHistoryAndStrip(history, latest, latestSettleIso);
}

// ─── analytics ──────────────────────────────────────────────────────────────

const STRIP_BOARD_DELTA_IDS: VintageId[] = ["1D", "1W", "1M"];
const DELTA_GRID_IDS: VintageId[] = ["1D", "1W", "1M", "3M", "6M", "1Y"];

export async function getCurveAnalytics(
  code: string,
  basisMode: BasisMode,
): Promise<CurveAnalyticsDto | null> {
  const curve = await findCurve(code);
  if (!curve || !curve.isActive) return null;
  const state = await loadCurveState(curve, basisMode);
  if (!state) return null;
  const { latest, latestSettle, resolved } = state;

  const series = await loadVintageSeries(curve, resolved, DELTA_GRID_IDS, basisMode);
  const byId = new Map(series.map((s) => [s.id, s]));

  // Strip board: BAL + next three CALs + rolling 12/36/60M, Δ vs 1D/1W/1M.
  const settleYear = Number(latestSettle.slice(0, 4));
  const boardDefs: { label: string; avg: (pts: CurvePoint[]) => number | null }[] = [
    { label: balStrip(latest, latestSettle).label, avg: (pts) => balStrip(pts, latestSettle).avg },
    ...[1, 2, 3].map((k) => ({
      label: calStrip(latest, settleYear + k).label,
      avg: (pts: CurvePoint[]) => calStrip(pts, settleYear + k).avg,
    })),
    ...([12, 36, 60] as const).map((m) => ({
      label: `${m}M`,
      avg: (pts: CurvePoint[]) => rollingStrip(pts, m).avg,
    })),
  ];
  const stripBoard: StripBoardRow[] = boardDefs.map(({ label, avg }) => {
    const cur = avg(latest);
    return {
      label,
      price: cur,
      deltas: STRIP_BOARD_DELTA_IDS.map((id) => {
        const v = byId.get(id);
        const prior = v ? avg(v.points) : null;
        const d = stripDelta(cur, prior);
        return { vintageId: id, resolvedDate: v?.resolvedDate ?? null, abs: d.abs, pct: d.pct };
      }),
    };
  });

  // Vintage-delta grid: tenor points + strip averages, Δ$ and Δ%.
  const latestTenors = tenorValues(latest);
  const deltaGrid: VintageDeltaRow[] = [];
  for (const id of DELTA_GRID_IDS) {
    const v = byId.get(id);
    if (!v) continue;
    const priorTenors = tenorValues(v.points);
    deltaGrid.push({
      vintageId: id,
      resolvedDate: v.resolvedDate,
      cells: latestTenors.map((cur, i) => stripDelta(cur, priorTenors[i] ?? null)),
    });
  }

  const structure = curveStructure(
    latest,
    byId.has("1Y") ? { resolvedDate: byId.get("1Y")!.resolvedDate, points: byId.get("1Y")!.points } : null,
  );

  const seasonality =
    curve.group === "GAS"
      ? gasSeasonality(latest, byId.get("1M")?.points ?? null, latestSettle)
      : null;

  return {
    code: curve.code,
    basisMode,
    latestSettleDate: latestSettle,
    stripBoard,
    structure,
    seasonality,
    tenorColumns: tenorColumns(latest),
    deltaGrid,
    snapshotCount: state.snapshotCount,
  };
}

// ─── export (futures only — never history) ──────────────────────────────────

export async function buildExportTable(
  curveCodes: string[],
  vintageId: VintageId,
  basisMode: BasisMode,
): Promise<ExportTableDto | null> {
  const columns: { header: string; byMonth: Map<string, number>; decimals: number }[] = [];

  for (const code of curveCodes) {
    const curve = await findCurve(code);
    if (!curve || !curve.isActive) continue;
    const state = await loadCurveState(curve, basisMode);
    if (!state) continue;

    let points = state.latest;
    let asOf = state.latestSettle;
    if (vintageId !== "LATEST") {
      const r = state.resolved.find((x) => x.id === vintageId);
      if (!r || r.resolvedDate === null) continue;
      const raw = await snapshotPoints(curve.id, r.resolvedDate);
      points = await applyBasisMode(curve, raw, r.resolvedDate, basisMode);
      asOf = r.resolvedDate;
    }
    if (points.length === 0) continue;

    const basisTag = curve.kind === "BASIS" && basisMode === "DIFF" ? " BASIS" : "";
    columns.push({
      header: `${curve.name}${basisTag} (${curve.unit}) ${shortDate(asOf)}`,
      byMonth: new Map(points.map((p) => [p.contractMonth, p.price])),
      decimals: curve.decimals,
    });
  }
  if (columns.length === 0) return null;

  const allMonths = [...new Set(columns.flatMap((c) => [...c.byMonth.keys()]))].sort();
  return {
    headers: ["CONTRACT", ...columns.map((c) => c.header)],
    rows: allMonths.map((m) => [
      m,
      ...columns.map((c) => {
        const v = c.byMonth.get(m);
        return v === undefined ? null : Number(v.toFixed(c.decimals));
      }),
    ]),
  };
}

// Re-exported for the strip-change table's column sublabels.
export { TENOR_DEFS, stripAvgByIndex };
