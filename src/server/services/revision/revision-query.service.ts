/**
 * Engine 1 — read side. Shapes the stored snapshots/scores/aggregates into the
 * payloads the Research UI consumes (summary feed, idea queue, per-stock
 * trajectory, rotation, breadth heatmap, calendar, decomposition). No mutation.
 */
import type { RevisionGroupType, RevisionTransitionType } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import { REVISION_THRESHOLDS } from "@/lib/revision/config";
import { decomposeComposites } from "@/lib/revision/derived";
import { getLatestValidation } from "./revision-validation.service";
import {
  getCompanyNamesByTicker,
  pickDisplayName,
} from "@/server/services/security-name.service";

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface QueuePayload {
  snapshotDate: string;
  generatedAt: string;
  count: number;
  rows: Array<Record<string, unknown>>;
}

/**
 * Latest ranked research queue (optionally truncated to `limit` rows), with
 * each row's `companyName` overridden from the live market-map source
 * (`Security.name`) so display names match the market map and pick up custom
 * edits immediately. Falls back to the baked name then the ticker.
 */
export async function getLatestQueue(limit?: number): Promise<QueuePayload | null> {
  const snap = await prisma.researchQueueSnapshot.findFirst({ orderBy: { snapshotDate: "desc" } });
  if (!snap) return null;
  const payload = snap.payloadJson as unknown as QueuePayload;
  const rows = Array.isArray(payload.rows)
    ? limit
      ? payload.rows.slice(0, limit)
      : payload.rows
    : [];
  const tickers = rows
    .map((r) => (typeof r.ticker === "string" ? r.ticker : null))
    .filter((t): t is string => t !== null);
  const namesByTicker = await getCompanyNamesByTicker(prisma, tickers);
  const enriched = rows.map((r) => {
    const ticker = typeof r.ticker === "string" ? r.ticker : null;
    if (!ticker) return r;
    const baked = typeof r.companyName === "string" ? r.companyName : null;
    return { ...r, companyName: pickDisplayName(namesByTicker, ticker, baked) };
  });
  return { ...payload, rows: enriched };
}

export interface TrajectoryPoint {
  snapshotDate: string;
  composite: number | null;
  rank: number | null;
  subsectorDecile: number | null;
  newArrival: boolean;
  signals: Record<string, number | null>;
  epsAvg: number | null;
  ptConsensus: number | null;
}

/** Per-stock signal trajectory across all stored weeks (climb vs spike vs round-trip). */
export async function getTrajectory(ticker: string): Promise<{
  ticker: string;
  points: TrajectoryPoint[];
}> {
  const t = ticker.toUpperCase();
  const [scores, snaps] = await Promise.all([
    prisma.revisionScore.findMany({ where: { ticker: t }, orderBy: { snapshotDate: "asc" } }),
    prisma.revisionSnapshot.findMany({
      where: { ticker: t },
      orderBy: { snapshotDate: "asc" },
      select: { snapshotDate: true, epsAvg: true, ptConsensus: true },
    }),
  ]);
  const snapByDate = new Map(snaps.map((s) => [isoOf(s.snapshotDate), s]));
  const points: TrajectoryPoint[] = scores.map((sc) => {
    const date = isoOf(sc.snapshotDate);
    const sj = (sc.scoreJson as { signals?: Record<string, number | null> } | null) ?? {};
    const snap = snapByDate.get(date);
    return {
      snapshotDate: date,
      composite: sc.composite,
      rank: sc.rank,
      subsectorDecile: sc.subsectorDecile,
      newArrival: sc.newArrival,
      signals: sj.signals ?? {},
      epsAvg: snap?.epsAvg !== undefined && snap?.epsAvg !== null ? Number(snap.epsAvg) : null,
      ptConsensus:
        snap?.ptConsensus !== undefined && snap?.ptConsensus !== null ? Number(snap.ptConsensus) : null,
    };
  });
  return { ticker: t, points };
}

async function recentSnapshotDates(weeks: number): Promise<Date[]> {
  const rows = await prisma.revisionSectorAggregate.findMany({
    distinct: ["snapshotDate"],
    orderBy: { snapshotDate: "desc" },
    take: weeks,
    select: { snapshotDate: true },
  });
  return rows.map((r) => r.snapshotDate).sort((a, b) => a.getTime() - b.getTime());
}

export interface RotationPayload {
  groupType: RevisionGroupType;
  dates: string[];
  series: Array<{ groupKey: string; points: Array<{ date: string; compositeMean: number | null; breadth: number | null }> }>;
}

/** Sector/subsector composite-mean lines over the last `weeks` snapshots. */
export async function getRotation(
  groupType: RevisionGroupType,
  weeks = 52,
): Promise<RotationPayload> {
  const dates = await recentSnapshotDates(weeks);
  if (dates.length === 0) return { groupType, dates: [], series: [] };
  const rows = await prisma.revisionSectorAggregate.findMany({
    where: { groupType, snapshotDate: { in: dates } },
    orderBy: { snapshotDate: "asc" },
  });
  const dateIsos = dates.map(isoOf);
  const byGroup = new Map<string, Map<string, { compositeMean: number | null; breadth: number | null }>>();
  for (const r of rows) {
    const g = byGroup.get(r.groupKey) ?? new Map();
    g.set(isoOf(r.snapshotDate), { compositeMean: r.compositeMean, breadth: r.breadth });
    byGroup.set(r.groupKey, g);
  }
  const series = [...byGroup.entries()].map(([groupKey, m]) => ({
    groupKey,
    points: dateIsos.map((date) => ({
      date,
      compositeMean: m.get(date)?.compositeMean ?? null,
      breadth: m.get(date)?.breadth ?? null,
    })),
  }));
  return { groupType, dates: dateIsos, series };
}

export type RatingChangeKind = "RATING" | "PRICE_TARGET";

export interface RatingChangeRow {
  kind: RatingChangeKind;
  ticker: string;
  companyName: string;
  sector: string | null;
  /** Event date (yyyy-MM-dd). */
  date: string;
  /** RATING fields. */
  gradingCompany: string | null;
  previousGrade: string | null;
  newGrade: string | null;
  action: string | null;
  /** PRICE_TARGET fields. */
  analystCompany: string | null;
  analystName: string | null;
  priceTarget: number | null;
  priceWhenPosted: number | null;
  newsPublisher: string | null;
  /** QUEUE link: whether the ticker currently carries a side flag, and its gap. */
  inQueue?: boolean;
  gapScore?: number | null;
  side?: string | null;
}

export interface RatingChangesPayload {
  generatedAt: string;
  count: number;
  rows: RatingChangeRow[];
}

/** Plain (DB-free) rating event for the pure merge. */
export interface RatingEventInput {
  ticker: string;
  eventDate: Date;
  gradingCompany: string | null;
  previousGrade: string | null;
  newGrade: string | null;
  action: string | null;
}

/** Plain (DB-free) price-target event for the pure merge. */
export interface PriceTargetEventInput {
  ticker: string;
  publishedDate: Date;
  analystCompany: string | null;
  analystName: string | null;
  priceTarget: number | null;
  priceWhenPosted: number | null;
  newsPublisher: string | null;
}

/**
 * Pure: merge rating + price-target events into one time-descending feed,
 * truncated to `limit`. `companyName`/`sector` are left as the ticker / null
 * here; the caller overlays the live display name + reference sector. Safe to
 * unit-test (no DB, no Decimal).
 */
export function mergeRatingChanges(
  ratings: RatingEventInput[],
  targets: PriceTargetEventInput[],
  limit: number,
): RatingChangeRow[] {
  const merged: Array<{ ts: number; row: RatingChangeRow }> = [];
  for (const r of ratings) {
    merged.push({
      ts: r.eventDate.getTime(),
      row: {
        kind: "RATING",
        ticker: r.ticker,
        companyName: r.ticker,
        sector: null,
        date: isoOf(r.eventDate),
        gradingCompany: r.gradingCompany,
        previousGrade: r.previousGrade,
        newGrade: r.newGrade,
        action: r.action,
        analystCompany: null,
        analystName: null,
        priceTarget: null,
        priceWhenPosted: null,
        newsPublisher: null,
      },
    });
  }
  for (const t of targets) {
    merged.push({
      ts: t.publishedDate.getTime(),
      row: {
        kind: "PRICE_TARGET",
        ticker: t.ticker,
        companyName: t.ticker,
        sector: null,
        date: isoOf(t.publishedDate),
        gradingCompany: null,
        previousGrade: null,
        newGrade: null,
        action: null,
        analystCompany: t.analystCompany,
        analystName: t.analystName,
        priceTarget: t.priceTarget,
        priceWhenPosted: t.priceWhenPosted,
        newsPublisher: t.newsPublisher,
      },
    });
  }
  merged.sort((a, b) => b.ts - a.ts);
  return merged.slice(0, limit).map((m) => m.row);
}

/**
 * Recent analyst rating changes (upgrades/downgrades) and price-target
 * revisions, merged into one time-descending feed. Reads the event-level
 * RatingEvent / PriceTargetEvent tables (tailed daily by the revision runner)
 * and overlays the live market-map display name + reference sector.
 */
export async function getRecentRatingChanges(opts: {
  ticker?: string;
  limit?: number;
}): Promise<RatingChangesPayload> {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
  const tickerFilter = opts.ticker ? { ticker: opts.ticker.trim().toUpperCase() } : {};

  const [ratings, targets] = await Promise.all([
    prisma.ratingEvent.findMany({
      where: tickerFilter,
      orderBy: { eventDate: "desc" },
      take: limit,
    }),
    prisma.priceTargetEvent.findMany({
      where: tickerFilter,
      orderBy: { publishedDate: "desc" },
      take: limit,
    }),
  ]);

  const rows = mergeRatingChanges(
    ratings,
    targets.map((t) => ({
      ticker: t.ticker,
      publishedDate: t.publishedDate,
      analystCompany: t.analystCompany,
      analystName: t.analystName,
      priceTarget: t.priceTarget != null ? Number(t.priceTarget) : null,
      priceWhenPosted: t.priceWhenPosted != null ? Number(t.priceWhenPosted) : null,
      newsPublisher: t.newsPublisher,
    })),
    limit,
  );

  const tickers = [...new Set(rows.map((r) => r.ticker))];
  const [namesByTicker, refs] = await Promise.all([
    getCompanyNamesByTicker(prisma, tickers),
    prisma.revisionReference.findMany({
      where: { ticker: { in: tickers } },
      select: { ticker: true, companyName: true, sector: true },
    }),
  ]);
  const refByTicker = new Map(refs.map((r) => [r.ticker, r]));

  // Tie raw events to the scored idea set: current side flag + gap per ticker.
  const latestScoreDate = (
    await prisma.revisionScore.findFirst({ orderBy: { snapshotDate: "desc" }, select: { snapshotDate: true } })
  )?.snapshotDate;
  const queueState = latestScoreDate
    ? await prisma.revisionScore.findMany({
        where: { snapshotDate: latestScoreDate, ticker: { in: tickers } },
        select: { ticker: true, side: true, gapScore: true },
      })
    : [];
  const queueByTicker = new Map(queueState.map((q) => [q.ticker, q]));

  for (const row of rows) {
    const ref = refByTicker.get(row.ticker);
    row.companyName = pickDisplayName(namesByTicker, row.ticker, ref?.companyName ?? null);
    row.sector = ref?.sector ?? null;
    const q = queueByTicker.get(row.ticker);
    row.inQueue = q?.side != null;
    row.gapScore = q?.gapScore ?? null;
    row.side = q?.side ?? null;
  }

  return { generatedAt: new Date().toISOString(), count: rows.length, rows };
}

export interface HeatmapPayload {
  groupType: RevisionGroupType;
  dates: string[];
  groups: string[];
  cells: Array<{ groupKey: string; values: Array<number | null> }>; // breadth per date
}

/** Breadth heatmap: groups (rows) × months (cols). */
export async function getHeatmap(
  groupType: RevisionGroupType,
  weeks = 52,
): Promise<HeatmapPayload> {
  const rot = await getRotation(groupType, weeks);
  const cells = rot.series.map((s) => ({
    groupKey: s.groupKey,
    values: s.points.map((p) => p.breadth),
  }));
  return { groupType, dates: rot.dates, groups: rot.series.map((s) => s.groupKey), cells };
}

// ─── SUMMARY (transition feed) ──────────────────────────────────────────────

export interface SummaryRow {
  type: RevisionTransitionType;
  ticker: string | null;
  companyName: string | null;
  groupType: RevisionGroupType | null;
  groupKey: string | null;
  reason: string;
  gapScore: number | null;
  snapshotDate: string;
}

export interface SummaryPayload {
  snapshotDate: string;
  prevDate: string | null;
  generatedAt: string;
  stats: {
    icCurrent: number | null;
    icLongRun: number | null;
    icSource: "FULL" | "LEG_B" | null;
    icWarning: boolean;
    breadth: number | null; // universe mean estimate breadth
    actionable: { n: number; longs: number; shorts: number };
    newCount: number;
    exitCount: number;
    legADepthWeeks: number;
  };
  groups: {
    newIdeas: SummaryRow[];
    exits: SummaryRow[];
    catalysts: SummaryRow[];
    groupTriggers: SummaryRow[];
  };
}

const fmtZ = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}σ` : "n/a";

/** One-line generated reason per transition, templated from its payload. */
export function transitionReason(type: RevisionTransitionType, payload: Record<string, unknown>): string {
  switch (type) {
    case "NEW_LONG":
      return `TOP DECILE, GAP ${fmtZ(payload.gapScore)} UNPRICED — ENTERED LONG SET`;
    case "NEW_SHORT":
      return `BOTTOM DECILE, GAP ${fmtZ(payload.gapScore)} UNPRICED — ENTERED SHORT SET`;
    case "GAP_CLOSED":
      return `GAP CLOSED (NOW ${fmtZ(payload.gapScore)}) — WAS ${String(payload.priorSide ?? "FLAGGED")}`;
    case "STREAK_BROKEN":
      return `${String(payload.priorLen ?? "?")}W ${Number(payload.priorSign) < 0 ? "NEGATIVE" : "POSITIVE"} STREAK BROKEN`;
    case "ER_WITHIN_7D":
      return `REPORTS IN ${String(payload.daysToEarnings ?? "?")}D — REV Z ${fmtZ(payload.compositeZ)} INTO PRINT`;
    case "GROUP_INFLECTION":
      return `GROUP MEAN CROSSED +${Number(payload.level ?? 1).toFixed(1)}σ (NOW ${fmtZ(payload.meanZ)})`;
    case "GROUP_ROLLOVER":
      return `GROUP MEAN ROLLED THROUGH ${Number(payload.level ?? -1).toFixed(1)}σ (NOW ${fmtZ(payload.meanZ)})`;
    case "NEXT_DOMINO":
      return `GROUP HOT (${fmtZ(payload.groupMeanZ)}), OWN Z ${fmtZ(payload.ownZ)} — POTENTIAL CATCH-UP ${String(payload.direction ?? "")}`.trim();
    default:
      return String(type);
  }
}

/** The SUMMARY tab payload: grouped transitions at the latest score date + upcoming ER catalysts. */
export async function getSummary(): Promise<SummaryPayload | null> {
  const latestScore = await prisma.revisionScore.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  if (!latestScore) return null;
  const latest = latestScore.snapshotDate;
  const prevRow = await prisma.revisionScore.findFirst({
    where: { snapshotDate: { lt: latest } },
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });

  const weekly = await prisma.signalTransition.findMany({
    where: { snapshotDate: latest, type: { not: "ER_WITHIN_7D" } },
    orderBy: { firedAt: "asc" },
  });
  // ER catalysts are keyed to the earnings date — show the still-upcoming ones.
  const catalystsRaw = await prisma.signalTransition.findMany({
    where: { type: "ER_WITHIN_7D", snapshotDate: { gte: latest } },
    orderBy: { snapshotDate: "asc" },
  });

  const all = [...weekly, ...catalystsRaw];
  const tickers = [...new Set(all.map((t) => t.ticker).filter((t): t is string => t !== null))];
  const namesByTicker = await getCompanyNamesByTicker(prisma, tickers);
  const toRow = (t: (typeof all)[number]): SummaryRow => {
    const payload = (t.payload ?? {}) as Record<string, unknown>;
    return {
      type: t.type,
      ticker: t.ticker,
      companyName: t.ticker ? pickDisplayName(namesByTicker, t.ticker, null) : null,
      groupType: t.groupType,
      groupKey: t.groupKey,
      reason: transitionReason(t.type, payload),
      gapScore: typeof payload.gapScore === "number" ? payload.gapScore : null,
      snapshotDate: isoOf(t.snapshotDate),
    };
  };

  const newIdeas = all.filter((t) => t.type === "NEW_LONG" || t.type === "NEW_SHORT").map(toRow);
  const exits = all.filter((t) => t.type === "GAP_CLOSED" || t.type === "STREAK_BROKEN").map(toRow);
  const catalysts = catalystsRaw.map(toRow);
  const groupTriggers = all
    .filter((t) => t.type === "GROUP_INFLECTION" || t.type === "GROUP_ROLLOVER" || t.type === "NEXT_DOMINO")
    .map(toRow);

  // Header stats.
  const [validation, scores, sectorAggs, histCount] = await Promise.all([
    getLatestValidation(),
    prisma.revisionScore.findMany({ where: { snapshotDate: latest }, select: { side: true } }),
    prisma.revisionSectorAggregate.findMany({
      where: { snapshotDate: latest, groupType: "SECTOR" },
      select: { breadth: true, nameCount: true },
    }),
    prisma.revisionScore.findMany({ distinct: ["snapshotDate"], select: { snapshotDate: true } }),
  ]);
  const longs = scores.filter((s) => s.side === "LONG").length;
  const shorts = scores.filter((s) => s.side === "SHORT").length;
  let breadthSum = 0;
  let breadthN = 0;
  for (const a of sectorAggs) {
    if (a.breadth !== null && a.nameCount) {
      breadthSum += a.breadth * a.nameCount;
      breadthN += a.nameCount;
    }
  }

  return {
    snapshotDate: isoOf(latest),
    prevDate: prevRow ? isoOf(prevRow.snapshotDate) : null,
    generatedAt: new Date().toISOString(),
    stats: {
      icCurrent: validation?.icCurrent ?? null,
      icLongRun: validation?.icLongRun ?? null,
      icSource: validation?.icSource ?? null,
      icWarning: (validation?.icCurrent ?? 0) < 0,
      breadth: breadthN > 0 ? breadthSum / breadthN : null,
      actionable: { n: longs + shorts, longs, shorts },
      newCount: newIdeas.length,
      exitCount: exits.length,
      legADepthWeeks: histCount.length,
    },
    groups: { newIdeas, exits, catalysts, groupTriggers },
  };
}

// ─── CALENDAR (upcoming earnings with revision setup) ───────────────────────

export interface CalendarRow {
  ticker: string;
  companyName: string;
  erDate: string;
  days: number;
  composite: number | null; // proximity-weighted REV Z into the print
  gapScore: number | null;
  side: string | null;
  streakHistory: Array<-1 | 0 | 1>;
  streakSource: string | null;
  setupLine: string;
}

export interface CalendarPayload {
  generatedAt: string;
  today: string;
  days: number;
  weeks: Array<{ label: string; rows: CalendarRow[] }>;
}

function buildSetupLine(score: {
  composite: number | null;
  gapScore: number | null;
  streakLen: number | null;
  streakSign: number | null;
  dispersionTrend: string | null;
  side: string | null;
}): string {
  const parts: string[] = [];
  if (score.streakLen && score.streakLen >= 2 && score.streakSign) {
    parts.push(`${score.streakLen}W ${score.streakSign > 0 ? "POS" : "NEG"} STREAK`);
  }
  if (score.gapScore !== null && Math.abs(score.gapScore) >= REVISION_THRESHOLDS.gapClosedAbsGap) {
    parts.push(`GAP ${score.gapScore >= 0 ? "+" : ""}${score.gapScore.toFixed(1)} UNPRICED`);
  }
  if (score.dispersionTrend && score.dispersionTrend !== "FLAT") {
    parts.push(`DISP ${score.dispersionTrend}`);
  }
  if (score.side) parts.push(`IN QUEUE (${score.side === "LONG" ? "L" : "S"})`);
  return parts.length ? parts.join(" · ") : "NO NOTABLE SETUP";
}

/** Names reporting in the next `days` days with a live signal or a queue flag, grouped by week. */
export async function getCalendar(days: number): Promise<CalendarPayload> {
  const today = new Date();
  const todayIso = isoOf(today);
  const todayMs = new Date(`${todayIso}T00:00:00Z`).getTime();
  const until = new Date(todayMs + days * 86_400_000);

  const latestSnapDate = (
    await prisma.revisionSnapshot.findFirst({ orderBy: { snapshotDate: "desc" }, select: { snapshotDate: true } })
  )?.snapshotDate;
  if (!latestSnapDate) return { generatedAt: new Date().toISOString(), today: todayIso, days, weeks: [] };
  const snaps = await prisma.revisionSnapshot.findMany({
    where: {
      snapshotDate: latestSnapDate,
      nextEarningsDate: { gte: new Date(`${todayIso}T00:00:00Z`), lte: until },
    },
    select: { ticker: true, nextEarningsDate: true },
  });
  const latestScoreDate = (
    await prisma.revisionScore.findFirst({ orderBy: { snapshotDate: "desc" }, select: { snapshotDate: true } })
  )?.snapshotDate;
  const scores = latestScoreDate
    ? await prisma.revisionScore.findMany({
        where: { snapshotDate: latestScoreDate, ticker: { in: snaps.map((s) => s.ticker) } },
        select: {
          ticker: true,
          composite: true,
          gapScore: true,
          side: true,
          streakLen: true,
          streakSign: true,
          streakSource: true,
          dispersionTrend: true,
          scoreJson: true,
        },
      })
    : [];
  const scoreByTicker = new Map(scores.map((s) => [s.ticker, s]));
  const namesByTicker = await getCompanyNamesByTicker(prisma, snaps.map((s) => s.ticker));

  const rows: CalendarRow[] = [];
  for (const s of snaps) {
    const sc = scoreByTicker.get(s.ticker);
    if (!sc) continue;
    const liveSignal = sc.composite !== null && Math.abs(sc.composite) >= REVISION_THRESHOLDS.erMinAbsRevisionZ;
    const inQueue = sc.side !== null;
    if (!liveSignal && !inQueue) continue;
    const derived = ((sc.scoreJson as { derived?: { streakHistory?: Array<-1 | 0 | 1> } } | null)?.derived ?? {}) as {
      streakHistory?: Array<-1 | 0 | 1>;
    };
    const erIso = isoOf(s.nextEarningsDate!);
    rows.push({
      ticker: s.ticker,
      companyName: pickDisplayName(namesByTicker, s.ticker, null) ?? s.ticker,
      erDate: erIso,
      days: Math.round((s.nextEarningsDate!.getTime() - todayMs) / 86_400_000),
      composite: sc.composite,
      gapScore: sc.gapScore,
      side: sc.side,
      streakHistory: derived.streakHistory ?? [],
      streakSource: sc.streakSource,
      setupLine: buildSetupLine(sc),
    });
  }
  rows.sort((a, b) => a.days - b.days || (b.composite ?? 0) - (a.composite ?? 0));

  const weeks: CalendarPayload["weeks"] = [];
  const labelOf = (d: number, erIso: string): string => {
    if (d < 7) return "THIS WEEK";
    if (d < 14) return "NEXT WEEK";
    const er = new Date(`${erIso}T00:00:00Z`);
    const monday = new Date(er.getTime() - ((er.getUTCDay() + 6) % 7) * 86_400_000);
    return `WEEK OF ${monday.toISOString().slice(5, 10).replace("-", "/")}`;
  };
  for (const row of rows) {
    const label = labelOf(row.days, row.erDate);
    const bucket = weeks.find((w) => w.label === label);
    if (bucket) bucket.rows.push(row);
    else weeks.push({ label, rows: [row] });
  }
  return { generatedAt: new Date().toISOString(), today: todayIso, days, weeks };
}

// ─── SIGNAL BRIEF (Overview portfolio-lens read helpers) ────────────────────
// Thin per-ticker reads for the Overview signal modules: latest scores,
// the latest transition set, and next-earnings dates. Same latest-date
// resolution as the panels above; no new computation.

export interface TickerSignalScore {
  ticker: string;
  gapScore: number | null;
  composite: number | null;
  side: string | null;
  streakLen: number | null;
  streakSign: number | null;
  subsectorDecile: number | null;
  sectorDecile: number | null;
}

export interface LatestScoresPayload {
  snapshotDate: string | null;
  /** Accruing-window state from the baked queue payload (axis-suffix source). */
  effectiveWindow: { legAWeeks: number; composite4wWindow: number } | null;
  scores: TickerSignalScore[];
}

/** Latest RevisionScore per requested ticker (missing tickers are simply absent). */
export async function getLatestScoresForTickers(tickers: string[]): Promise<LatestScoresPayload> {
  const latest = (
    await prisma.revisionScore.findFirst({ orderBy: { snapshotDate: "desc" }, select: { snapshotDate: true } })
  )?.snapshotDate;
  const queueSnap = await prisma.researchQueueSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { payloadJson: true },
  });
  const ew = (queueSnap?.payloadJson as { effectiveWindow?: { legAWeeks?: number; composite4wWindow?: number } } | null)
    ?.effectiveWindow;
  const effectiveWindow =
    typeof ew?.legAWeeks === "number" && typeof ew?.composite4wWindow === "number"
      ? { legAWeeks: ew.legAWeeks, composite4wWindow: ew.composite4wWindow }
      : null;
  if (!latest || tickers.length === 0) {
    return { snapshotDate: latest ? isoOf(latest) : null, effectiveWindow, scores: [] };
  }
  const rows = await prisma.revisionScore.findMany({
    where: { snapshotDate: latest, ticker: { in: tickers } },
    select: {
      ticker: true,
      gapScore: true,
      composite: true,
      side: true,
      streakLen: true,
      streakSign: true,
      subsectorDecile: true,
      sectorDecile: true,
    },
  });
  return { snapshotDate: isoOf(latest), effectiveWindow, scores: rows };
}

/**
 * Latest RevisionScore for EVERY scored ticker (the CONFLUENCE board's
 * revision leg). Same shape as getLatestScoresForTickers, universe-wide —
 * one bulk read at the latest snapshot date.
 */
export async function getLatestScoresAll(): Promise<LatestScoresPayload> {
  const latest = (
    await prisma.revisionScore.findFirst({ orderBy: { snapshotDate: "desc" }, select: { snapshotDate: true } })
  )?.snapshotDate;
  const queueSnap = await prisma.researchQueueSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { payloadJson: true },
  });
  const ew = (queueSnap?.payloadJson as { effectiveWindow?: { legAWeeks?: number; composite4wWindow?: number } } | null)
    ?.effectiveWindow;
  const effectiveWindow =
    typeof ew?.legAWeeks === "number" && typeof ew?.composite4wWindow === "number"
      ? { legAWeeks: ew.legAWeeks, composite4wWindow: ew.composite4wWindow }
      : null;
  if (!latest) return { snapshotDate: null, effectiveWindow, scores: [] };
  const rows = await prisma.revisionScore.findMany({
    where: { snapshotDate: latest },
    select: {
      ticker: true,
      gapScore: true,
      composite: true,
      side: true,
      streakLen: true,
      streakSign: true,
      subsectorDecile: true,
      sectorDecile: true,
    },
  });
  return { snapshotDate: isoOf(latest), effectiveWindow, scores: rows };
}

export interface LatestTransitionRow {
  type: RevisionTransitionType;
  ticker: string | null;
  groupType: RevisionGroupType | null;
  groupKey: string | null;
  snapshotDate: string;
  reason: string;
  payload: Record<string, unknown>;
}

/**
 * The latest transition set — the same rows getSummary groups, returned flat
 * (weekly transitions at the latest score date + still-upcoming ER catalysts),
 * without the header stats. Empty array is a valid first-run outcome.
 */
export async function getLatestTransitions(): Promise<{ snapshotDate: string | null; rows: LatestTransitionRow[] }> {
  const latestScore = await prisma.revisionScore.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  if (!latestScore) return { snapshotDate: null, rows: [] };
  const latest = latestScore.snapshotDate;
  const [weekly, catalysts] = await Promise.all([
    prisma.signalTransition.findMany({
      where: { snapshotDate: latest, type: { not: "ER_WITHIN_7D" } },
      orderBy: { firedAt: "asc" },
    }),
    prisma.signalTransition.findMany({
      where: { type: "ER_WITHIN_7D", snapshotDate: { gte: latest } },
      orderBy: { snapshotDate: "asc" },
    }),
  ]);
  const rows = [...weekly, ...catalysts].map((t) => {
    const payload = (t.payload ?? {}) as Record<string, unknown>;
    return {
      type: t.type,
      ticker: t.ticker,
      groupType: t.groupType,
      groupKey: t.groupKey,
      snapshotDate: isoOf(t.snapshotDate),
      reason: transitionReason(t.type, payload),
      payload,
    };
  });
  return { snapshotDate: isoOf(latest), rows };
}

export interface TickerEarningsRow {
  ticker: string;
  erDate: string;
  days: number;
}

/**
 * Next earnings dates for the requested tickers within `days`, read from the
 * latest stored snapshot (held names appear regardless of any signal — a print
 * on a held position is a risk event). `coveredTickers` = tickers with ANY row
 * at the latest snapshot date; a requested ticker not in it hasn't been
 * onboarded into the universe yet (the caller footnotes those). A covered
 * ticker with no upcoming ER inside the window is normal and absent from rows.
 */
export async function getNextEarningsForTickers(
  tickers: string[],
  days: number,
): Promise<{ rows: TickerEarningsRow[]; coveredTickers: string[] }> {
  if (tickers.length === 0) return { rows: [], coveredTickers: [] };
  const latestSnapDate = (
    await prisma.revisionSnapshot.findFirst({ orderBy: { snapshotDate: "desc" }, select: { snapshotDate: true } })
  )?.snapshotDate;
  if (!latestSnapDate) return { rows: [], coveredTickers: [] };
  const todayIso = isoOf(new Date());
  const todayMs = new Date(`${todayIso}T00:00:00Z`).getTime();
  const snaps = await prisma.revisionSnapshot.findMany({
    where: { snapshotDate: latestSnapDate, ticker: { in: tickers } },
    select: { ticker: true, nextEarningsDate: true },
  });
  const untilMs = todayMs + days * 86_400_000;
  const rows: TickerEarningsRow[] = [];
  for (const s of snaps) {
    const er = s.nextEarningsDate?.getTime();
    if (er === undefined || er < todayMs || er > untilMs) continue;
    rows.push({
      ticker: s.ticker,
      erDate: isoOf(s.nextEarningsDate!),
      days: Math.round((er - todayMs) / 86_400_000),
    });
  }
  return { rows, coveredTickers: snaps.map((s) => s.ticker) };
}

// ─── DECOMP (group vs idiosyncratic split) ──────────────────────────────────

export interface DecompRow {
  ticker: string;
  companyName: string;
  groupKey: string;
  composite: number | null; // universe-relative (global) composite: grp + idio sum to it
  groupZ: number | null;
  idioZ: number | null;
  implication: string;
}

export interface DecompPayload {
  groupType: RevisionGroupType;
  snapshotDate: string;
  generatedAt: string;
  rows: DecompRow[];
}

/** Rule-generated implication label from the group/idio split. */
export function implicationLabel(comp: number | null, grp: number | null, idio: number | null): string {
  if (comp === null || grp === null || idio === null) return "—";
  const aGrp = Math.abs(grp);
  const aIdio = Math.abs(idio);
  if (aIdio >= 1 && aGrp < 0.5) return idio > 0 ? "PURE IDIO — CLEAN LONG" : "PURE IDIO — IDIO SHORT";
  if (aGrp >= 1 && aIdio <= 0.3) return grp > 0 ? "MOSTLY GROUP — NEXT DOMINO?" : "MOSTLY GROUP — HEDGE W/ SECTOR";
  if (aGrp >= 0.5 && aIdio >= 0.5 && Math.sign(grp) === Math.sign(idio))
    return grp > 0 ? "ALIGNED — SIZE ON IDIO" : "ALIGNED SHORT — SIZE ON IDIO";
  if (aGrp >= 0.5 && aIdio >= 0.5) return "OFFSETTING — GROUP VS NAME";
  return "BALANCED";
}

/**
 * Latest-week decomposition of the universe-relative composite into a group
 * component (re-z-scored group means at the requested level) + idio residual.
 * Recomputed at the requested groupType on read (pure, fast) so the toggle is
 * exact rather than approximated from the persisted primary-peer split.
 */
export async function getDecomp(groupType: RevisionGroupType): Promise<DecompPayload | null> {
  const latestScore = await prisma.revisionScore.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  if (!latestScore) return null;
  const latest = latestScore.snapshotDate;
  const scores = await prisma.revisionScore.findMany({
    where: { snapshotDate: latest },
    select: { ticker: true, scoreJson: true },
  });
  const refs = await prisma.revisionReference.findMany({
    where: { ticker: { in: scores.map((s) => s.ticker) } },
    select: { ticker: true, sector: true, subsector: true },
  });
  const refByTicker = new Map(refs.map((r) => [r.ticker, r]));
  const keys = scores.map((s) => {
    const ref = refByTicker.get(s.ticker);
    return groupType === "SECTOR"
      ? ref?.sector ?? "Unclassified"
      : ref?.subsector ?? ref?.sector ?? "Unclassified";
  });
  const globals = scores.map((s) => {
    const derived = (s.scoreJson as { derived?: { globalComposite?: unknown } } | null)?.derived;
    const v = derived?.globalComposite;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  });
  const { groupZ, idioZ } = decomposeComposites(globals, keys);
  const namesByTicker = await getCompanyNamesByTicker(prisma, scores.map((s) => s.ticker));

  const rows: DecompRow[] = scores
    .map((s, i) => ({
      ticker: s.ticker,
      companyName: pickDisplayName(namesByTicker, s.ticker, null) ?? s.ticker,
      groupKey: keys[i]!,
      composite: globals[i] ?? null,
      groupZ: groupZ[i] ?? null,
      idioZ: idioZ[i] ?? null,
      implication: implicationLabel(globals[i] ?? null, groupZ[i] ?? null, idioZ[i] ?? null),
    }))
    .filter((r) => r.composite !== null)
    .sort((a, b) => Math.abs(b.idioZ ?? 0) - Math.abs(a.idioZ ?? 0));

  return {
    groupType,
    snapshotDate: isoOf(latest),
    generatedAt: new Date().toISOString(),
    rows,
  };
}
