/**
 * CONFLUENCE — the composing read service behind GET /api/analysis/confluence,
 * and the weekly stage-history writer folded into the revision pipeline tail.
 *
 * Joins the three engines' already-baked payloads on ticker (fundamentals
 * discovery queue, latest revision scores, latest-quarter 13F name aggregates
 * + exit clusters) plus the precomputed factor grid for the idio annotation,
 * then applies the pure state/stage rules (@/lib/analysis/confluence/rules).
 * Read-layer composition: bulk reads only, no per-ticker queries, no new
 * scoring. Every leg degrades independently — a missing source shrinks
 * coverage, never throws.
 *
 * Stack depth is a count and the stage is a label — nothing here blends the
 * three sources into a number (rank tie-breaks use |gapScore| only).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import {
  getLatestScoresAll,
  type LatestScoresPayload,
} from "@/server/services/revision/revision-query.service";
import {
  getExitClusters,
  listPeriods,
} from "@/server/services/institutional/institutional-query.service";
import { readPerStockGridCache } from "@/server/services/factor-per-stock-cache.service";
import { loadPortfolioWeights } from "@/server/services/portfolio.service";
import {
  getCompanyNamesByTicker,
  pickDisplayName,
} from "@/server/services/security-name.service";
import { isVehicleClass } from "@/lib/institutional/security-class";
import {
  CONFLUENCE_THRESHOLDS,
  type ConfluenceThresholds,
} from "@/lib/analysis/confluence/config";
import {
  buildReadSentence,
  classifyFlows,
  classifyFundamentals,
  classifyRevisions,
  classifyStage,
  compareConfluenceRows,
  STAGE_ORDER,
  type Direction,
  type SignalState,
  type SourceKey,
  type Stage,
} from "@/lib/analysis/confluence/rules";

// ─── payload contract (the client type-imports these) ───────────────────────

export interface ConfluenceRowDto {
  rank: number;
  ticker: string;
  companyName: string | null;
  sector: string | null;
  subsector: string | null;
  f: SignalState;
  r: SignalState;
  f13: SignalState;
  stage: Stage;
  direction: Direction | null;
  stackDepth: number;
  singleSource: SourceKey | null;
  // F annotations
  decile: number | null;
  decileBasis: "SUBSECTOR" | "SECTOR" | null;
  trapFlag: boolean;
  flags: string[];
  // R annotations
  gapScore: number | null;
  revComposite: number | null;
  streakLen: number | null;
  streakSign: number | null;
  // 13F annotations
  netflowBps: number | null;
  lifecycleStage: string | null;
  crowded: boolean;
  inExitCluster: boolean;
  fundsHolding: number | null;
  deltaHolders: number | null;
  // cross-cutting
  /** Idio share fraction 0..1 from the factor grid; null = no decomposition stored. */
  idioShare: number | null;
  read: string;
  nextEr: { date: string; days: number } | null;
  held: { weight: number; isShort: boolean } | null;
}

export interface ConfluencePayload {
  generatedAt: string;
  asOf: {
    fundamentalsSnapshotDate: string | null;
    revisionSnapshotDate: string | null;
    effectiveWindow: { legAWeeks: number; composite4wWindow: number } | null;
    flowPeriod: string | null;
    idioAsOf: string | null;
  };
  /** Per-leg covered-name counts (universe sizes, pre-classification). */
  coverage: { fundamentals: number; revisions: number; flows: number };
  /** Per-stage counts over the FULL classified set (pre-truncation) — the funnel source. */
  counts: Array<{ stage: Stage; long: number; short: number; tied: number }>;
  /** Ranked rows; SINGLE stage truncated to singleStageMaxRows (strongest kept). */
  rows: ConfluenceRowDto[];
  /** How many SINGLE rows the cap removed (0 = none). */
  singleTruncated: number;
}

// ─── leg loaders (bulk reads; each caller .catch-degrades) ───────────────────

interface FundLegRow {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  subsector: string | null;
  subsectorDecile: number | null;
  sectorDecile: number | null;
  trapFlag: boolean;
  flags: string[];
}

async function loadDiscoveryLeg(): Promise<{ snapshotDate: string | null; byTicker: Map<string, FundLegRow> }> {
  // Read the baked snapshot payload directly — getDiscoveryQueue() also
  // triggers the market-map returns enrichment, which this board doesn't need.
  const snap = await prisma.discoveryQueueSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true, payloadJson: true },
  });
  const byTicker = new Map<string, FundLegRow>();
  if (!snap) return { snapshotDate: null, byTicker };
  const rows = (snap.payloadJson as { rows?: Array<Record<string, unknown>> } | null)?.rows ?? [];
  for (const r of rows) {
    if (typeof r.ticker !== "string") continue;
    byTicker.set(r.ticker, {
      ticker: r.ticker,
      companyName: typeof r.companyName === "string" ? r.companyName : null,
      sector: typeof r.sector === "string" ? r.sector : null,
      subsector: typeof r.subsector === "string" ? r.subsector : null,
      subsectorDecile: typeof r.subsectorDecile === "number" ? r.subsectorDecile : null,
      sectorDecile: typeof r.sectorDecile === "number" ? r.sectorDecile : null,
      trapFlag: r.trapFlag === true,
      flags: Array.isArray(r.flags) ? r.flags.filter((f): f is string => typeof f === "string") : [],
    });
  }
  return { snapshotDate: snap.snapshotDate.toISOString().slice(0, 10), byTicker };
}

interface FlowLegRow {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  subsector: string | null;
  netflowBps: number | null;
  lifecycleStage: string | null;
  crowded: boolean;
  fundsHolding: number;
  deltaHolders: number;
  inExitCluster: boolean;
}

async function loadFlowLeg(
  t: ConfluenceThresholds,
): Promise<{ filingPeriod: string | null; byTicker: Map<string, FlowLegRow> }> {
  const period = (await listPeriods())[0] ?? null;
  const byTicker = new Map<string, FlowLegRow>();
  if (!period) return { filingPeriod: null, byTicker };
  const [rows, clusters] = await Promise.all([
    prisma.institutionalNameAggregate.findMany({
      where: { filingPeriod: new Date(`${period}T00:00:00.000Z`) },
      select: {
        ticker: true,
        companyName: true,
        sector: true,
        subsector: true,
        securityClass: true,
        netflowBps: true,
        lifecycleStage: true,
        crowded: true,
        fundsHolding: true,
        deltaHolders: true,
      },
    }),
    getExitClusters(period, t.exitClusterMinExits).catch(() => null),
  ]);
  const exitSet = new Set((clusters?.rows ?? []).map((r) => r.ticker));
  for (const r of rows) {
    if (isVehicleClass(r.securityClass)) continue; // ETFs/funds aren't stackable theses
    byTicker.set(r.ticker, {
      ticker: r.ticker,
      companyName: r.companyName,
      sector: r.sector,
      subsector: r.subsector,
      netflowBps: r.netflowBps,
      lifecycleStage: r.lifecycleStage,
      crowded: r.crowded,
      fundsHolding: r.fundsHolding,
      deltaHolders: r.deltaHolders,
      inExitCluster: exitSet.has(r.ticker),
    });
  }
  return { filingPeriod: period, byTicker };
}

async function loadNextEarningsAll(): Promise<Map<string, { date: string; days: number }>> {
  const out = new Map<string, { date: string; days: number }>();
  const latest = (
    await prisma.revisionSnapshot.findFirst({ orderBy: { snapshotDate: "desc" }, select: { snapshotDate: true } })
  )?.snapshotDate;
  if (!latest) return out;
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayMs = new Date(`${todayIso}T00:00:00Z`).getTime();
  const rows = await prisma.revisionSnapshot.findMany({
    where: { snapshotDate: latest, nextEarningsDate: { gte: new Date(todayMs) } },
    select: { ticker: true, nextEarningsDate: true },
  });
  for (const r of rows) {
    out.set(r.ticker, {
      date: r.nextEarningsDate!.toISOString().slice(0, 10),
      days: Math.round((r.nextEarningsDate!.getTime() - todayMs) / 86_400_000),
    });
  }
  return out;
}

// ─── core composition (shared by the read endpoint and the weekly writer) ────

type ComposedRow = Omit<ConfluenceRowDto, "rank" | "companyName" | "idioShare" | "nextEr" | "held">;

interface ComposedBoard {
  rows: ComposedRow[];
  fundamentalsSnapshotDate: string | null;
  revisionSnapshotDate: string | null;
  effectiveWindow: LatestScoresPayload["effectiveWindow"];
  flowPeriod: string | null;
  coverage: { fundamentals: number; revisions: number; flows: number };
  fundNames: Map<string, string | null>;
  flowNames: Map<string, string | null>;
}

async function composeConfluenceRows(t: ConfluenceThresholds): Promise<ComposedBoard> {
  const [fund, rev, flow] = await Promise.all([
    loadDiscoveryLeg().catch(() => ({ snapshotDate: null, byTicker: new Map<string, FundLegRow>() })),
    getLatestScoresAll().catch(
      (): LatestScoresPayload => ({ snapshotDate: null, effectiveWindow: null, scores: [] }),
    ),
    loadFlowLeg(t).catch(() => ({ filingPeriod: null, byTicker: new Map<string, FlowLegRow>() })),
  ]);

  const revByTicker = new Map(rev.scores.map((s) => [s.ticker, s]));
  const universe = new Set<string>([
    ...fund.byTicker.keys(),
    ...revByTicker.keys(),
    ...flow.byTicker.keys(),
  ]);

  const rows: ComposedRow[] = [];
  for (const ticker of universe) {
    const fRow = fund.byTicker.get(ticker);
    const rRow = revByTicker.get(ticker);
    const fl = flow.byTicker.get(ticker);

    const f = classifyFundamentals(
      {
        covered: fRow !== undefined,
        subsectorDecile: fRow?.subsectorDecile ?? null,
        sectorDecile: fRow?.sectorDecile ?? null,
      },
      t,
    );
    const r = classifyRevisions({ covered: rRow !== undefined, side: rRow?.side ?? null });
    const f13 = classifyFlows(
      {
        covered: fl !== undefined,
        netflowBps: fl?.netflowBps ?? null,
        lifecycleStage: fl?.lifecycleStage ?? null,
        inExitCluster: fl?.inExitCluster ?? false,
      },
      t,
    );

    const staged = classifyStage({ f, r, f13 }, fl?.crowded ?? false);
    if (staged.stage === null) continue; // zero non-neutral — not a confluence row

    const decileBasis: "SUBSECTOR" | "SECTOR" | null =
      fRow?.subsectorDecile != null ? "SUBSECTOR" : fRow?.sectorDecile != null ? "SECTOR" : null;
    const decile = fRow?.subsectorDecile ?? fRow?.sectorDecile ?? null;

    rows.push({
      ticker,
      sector: fRow?.sector ?? fl?.sector ?? null,
      subsector: fRow?.subsector ?? fl?.subsector ?? null,
      f,
      r,
      f13,
      stage: staged.stage,
      direction: staged.direction,
      stackDepth: staged.stackDepth,
      singleSource: staged.singleSource,
      decile,
      decileBasis,
      trapFlag: fRow?.trapFlag ?? false,
      flags: fRow?.flags ?? [],
      gapScore: rRow?.gapScore ?? null,
      revComposite: rRow?.composite ?? null,
      streakLen: rRow?.streakLen ?? null,
      streakSign: rRow?.streakSign ?? null,
      netflowBps: fl?.netflowBps ?? null,
      lifecycleStage: fl?.lifecycleStage ?? null,
      crowded: fl?.crowded ?? false,
      inExitCluster: fl?.inExitCluster ?? false,
      fundsHolding: fl?.fundsHolding ?? null,
      deltaHolders: fl?.deltaHolders ?? null,
      read: buildReadSentence({
        stage: staged.stage,
        direction: staged.direction,
        f,
        r,
        f13,
        decile,
        gapScore: rRow?.gapScore ?? null,
        netflowBps: fl?.netflowBps ?? null,
        lifecycleStage: fl?.lifecycleStage ?? null,
        trapFlag: fRow?.trapFlag ?? false,
        crowded: fl?.crowded ?? false,
        inExitCluster: fl?.inExitCluster ?? false,
      }),
    });
  }

  rows.sort(compareConfluenceRows);

  return {
    rows,
    fundamentalsSnapshotDate: fund.snapshotDate,
    revisionSnapshotDate: rev.snapshotDate,
    effectiveWindow: rev.effectiveWindow,
    flowPeriod: flow.filingPeriod,
    coverage: {
      fundamentals: fund.byTicker.size,
      revisions: revByTicker.size,
      flows: flow.byTicker.size,
    },
    fundNames: new Map([...fund.byTicker.values()].map((x) => [x.ticker, x.companyName])),
    flowNames: new Map([...flow.byTicker.values()].map((x) => [x.ticker, x.companyName])),
  };
}

// ─── the read endpoint ───────────────────────────────────────────────────────

export async function getConfluenceBoard(
  opts: { portfolioId?: string } = {},
  t: ConfluenceThresholds = CONFLUENCE_THRESHOLDS,
): Promise<ConfluencePayload | null> {
  const [board, nextEr, idio, weights] = await Promise.all([
    composeConfluenceRows(t),
    loadNextEarningsAll().catch(() => new Map<string, { date: string; days: number }>()),
    readPerStockGridCache("MACRO14", 252).catch(() => null),
    opts.portfolioId
      ? loadPortfolioWeights(prisma, opts.portfolioId).catch(() => [])
      : Promise.resolve([]),
  ]);

  if (
    board.coverage.fundamentals === 0 &&
    board.coverage.revisions === 0 &&
    board.coverage.flows === 0
  ) {
    return null; // nothing computed anywhere yet — 404 NO_DATA upstream
  }

  const idioByTicker = new Map(
    (idio?.rows ?? []).map((r) => [r.ticker, r.idiosyncraticShare as number | null]),
  );
  const heldByTicker = new Map(
    weights
      .filter((w) => !w.isCash)
      .map((w) => [w.ticker, { weight: w.grossWeight, isShort: w.isShort }]),
  );

  // Funnel counts over the FULL classified set, before any truncation.
  const counts = STAGE_ORDER.map((stage) => {
    const inStage = board.rows.filter((r) => r.stage === stage);
    return {
      stage,
      long: inStage.filter((r) => r.direction === "LONG").length,
      short: inStage.filter((r) => r.direction === "SHORT").length,
      tied: inStage.filter((r) => r.direction === null).length,
    };
  });

  // Live display names (house convention), one bulk read over the board.
  const namesByTicker = await getCompanyNamesByTicker(
    prisma,
    board.rows.map((r) => r.ticker),
  ).catch(() => new Map<string, string>());

  // SINGLE-stage cap: rows are already ranked, so the cap keeps the strongest.
  let singleKept = 0;
  let singleTruncated = 0;
  const rows: ConfluenceRowDto[] = [];
  for (let i = 0; i < board.rows.length; i++) {
    const r = board.rows[i]!;
    if (r.stage === "SINGLE") {
      if (singleKept >= t.singleStageMaxRows) {
        singleTruncated++;
        continue;
      }
      singleKept++;
    }
    const baked = board.fundNames.get(r.ticker) ?? board.flowNames.get(r.ticker) ?? null;
    rows.push({
      ...r,
      rank: i + 1, // rank in the FULL ranked set — stable under truncation/filtering
      companyName: pickDisplayName(namesByTicker, r.ticker, baked),
      idioShare: idioByTicker.get(r.ticker) ?? null,
      nextEr: nextEr.get(r.ticker) ?? null,
      held: heldByTicker.get(r.ticker) ?? null,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    asOf: {
      fundamentalsSnapshotDate: board.fundamentalsSnapshotDate,
      revisionSnapshotDate: board.revisionSnapshotDate,
      effectiveWindow: board.effectiveWindow,
      flowPeriod: board.flowPeriod,
      idioAsOf: idio?.asOfDate ?? null,
    },
    coverage: board.coverage,
    counts,
    rows,
    singleTruncated,
  };
}

// ─── weekly stage-history writer (revision pipeline tail) ────────────────────

/**
 * Persist the stage board for one weekly grid date: one lean row per name
 * (stage, stack depth, direction) into ConfluenceStageSnapshot — the hook for
 * later validating whether stack depth predicts forward returns better than
 * any single signal. Reuses the exact same composition/rules as the read
 * endpoint. Idempotent per date (delete + createMany in one transaction).
 */
export async function writeConfluenceStageSnapshot(
  snapshotDate: string,
  t: ConfluenceThresholds = CONFLUENCE_THRESHOLDS,
): Promise<{ rowsWritten: number }> {
  const board = await composeConfluenceRows(t);
  const date = new Date(`${snapshotDate}T00:00:00Z`);
  const data: Prisma.ConfluenceStageSnapshotCreateManyInput[] = board.rows.map((r) => ({
    ticker: r.ticker,
    snapshotDate: date,
    stage: r.stage,
    stackDepth: r.stackDepth,
    direction: r.direction,
  }));
  await prisma.$transaction([
    prisma.confluenceStageSnapshot.deleteMany({ where: { snapshotDate: date } }),
    prisma.confluenceStageSnapshot.createMany({ data }),
  ]);
  return { rowsWritten: data.length };
}
