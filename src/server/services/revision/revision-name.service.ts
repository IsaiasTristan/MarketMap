/**
 * Engine 1 — Screen 3 (one name). The main view is the raw matched PT panel
 * the rank is built from: one step line per analyst over 18 months, on the
 * same deduped TipRanks ∪ FMP union and the same supersession keys the weekly
 * reconstruction uses (`meshPtSources`), so what the chart draws IS what the
 * score saw. Everything else on the page is a read of already-stored rows.
 */
import { prisma } from "@/infrastructure/db/client";
import { REVISION_THRESHOLDS } from "@/lib/revision/config";
import { meshPtSources, normalizeFirmName, type SourcedPtEvent } from "@/lib/revision/pt-sources";
import { getCompanyNamesByTicker, pickDisplayName } from "@/server/services/security-name.service";
import type { ScreenRowDto } from "./revision-screen.service";

const DAY_MS = 86_400_000;
/** History window of the analyst timeline. */
const PANEL_MONTHS = 18;
/** Depth of the four small multiples. */
const SMALL_MULTIPLE_WEEKS = 13;
/** Rows in the event log. */
const EVENT_LOG_LIMIT = 60;
/** "Raised in the last N weeks" in the generated footer sentence. */
const RECENT_RAISE_WEEKS = 3;

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type AnalystAction = "init" | "raise" | "cut" | "maintain";

export interface AnalystStep {
  date: string;
  target: number;
  action: AnalystAction;
  /** Close on the event date (last bar at or before it); null when unpriced. */
  price: number | null;
}

export interface AnalystSeries {
  key: string;
  label: string;
  stale: boolean;
  source: "TIPRANKS" | "FMP" | "MIXED";
  steps: AnalystStep[];
}

export interface NameEvent {
  date: string;
  firm: string | null;
  analyst: string | null;
  action: AnalystAction;
  rating: string | null;
  target: number;
  prevTarget: number | null;
  changePct: number | null;
  /** target / close-on-the-day − 1. */
  impliedUpside: number | null;
  source: "TIPRANKS" | "FMP";
}

export interface NamePayload {
  ticker: string;
  companyName: string | null;
  snapshotDate: string;
  /** Previous grid date — the scored week is (priorSnapshotDate, snapshotDate]. */
  priorSnapshotDate: string | null;
  row: ScreenRowDto | null;
  rank: number | null;
  universeSize: number;
  panel: {
    price: Array<{ date: string; close: number }>;
    earningsDates: string[];
    nextEarnings: string | null;
    analysts: AnalystSeries[];
    summary: string;
    staleDays: number;
  };
  peers: Array<{ ticker: string; ptRevOrthZ: number }>;
  smallMultiples: {
    weeks: string[];
    epsFy1: Array<number | null>;
    epsFy2: Array<number | null>;
    revFy1: Array<number | null>;
    revFy2: Array<number | null>;
    ptUp: number[];
    ptDown: number[];
    relReturn: Array<number | null>;
  };
  events: NameEvent[];
}

/** Latest close at or before each event date, from the stored EOD tape. */
function priceAt(series: Array<{ date: string; close: number }>, dateIso: string): number | null {
  let lo = 0;
  let hi = series.length - 1;
  let hit: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.date <= dateIso) {
      hit = series[mid]!.close;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return hit;
}

function classify(prev: number | null, target: number): AnalystAction {
  if (prev === null) return "init";
  if (target > prev) return "raise";
  if (target < prev) return "cut";
  return "maintain";
}

export async function getNameScreen(tickerRaw: string, date?: string): Promise<NamePayload | null> {
  const ticker = tickerRaw.trim().toUpperCase();
  const week = date
    ? await prisma.revisionUniverseWeek.findUnique({
        where: { snapshotDate: new Date(`${date}T00:00:00Z`) },
        select: { snapshotDate: true },
      })
    : await prisma.revisionUniverseWeek.findFirst({
        orderBy: { snapshotDate: "desc" },
        select: { snapshotDate: true },
      });
  if (!week) return null;
  const snapshotDate = week.snapshotDate;
  const priorWeek = await prisma.revisionUniverseWeek.findFirst({
    where: { snapshotDate: { lt: snapshotDate } },
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });

  const row = await prisma.revisionScreenRow.findUnique({
    where: { ticker_snapshotDate: { ticker, snapshotDate } },
  });
  if (!row) return null;

  const from = new Date(snapshotDate.getTime() - PANEL_MONTHS * 30 * DAY_MS);

  const [security, trRows, fmpRows, peersRaw, rankRow, universeSize, names] = await Promise.all([
    prisma.security.findUnique({ where: { ticker }, select: { id: true, name: true } }),
    prisma.tipRanksRatingEvent.findMany({
      where: { ticker, ratingDate: { gte: from, lte: snapshotDate }, priceTarget: { not: null } },
      select: {
        ratingDate: true,
        expertUID: true,
        analystName: true,
        firmName: true,
        priceTarget: true,
        recommendation: true,
        analystAction: true,
      },
      orderBy: { ratingDate: "asc" },
    }),
    prisma.priceTargetEvent.findMany({
      where: { ticker, publishedDate: { gte: from, lte: snapshotDate }, priceTarget: { not: null } },
      select: { publishedDate: true, analystCompany: true, analystName: true, priceTarget: true },
      orderBy: { publishedDate: "asc" },
    }),
    prisma.revisionScreenRow.findMany({
      where: { snapshotDate, subsector: row.subsector, ptRevOrthZ: { not: null } },
      select: { ticker: true, ptRevOrthZ: true },
    }),
    prisma.revisionScore.findUnique({
      where: { ticker_snapshotDate: { ticker, snapshotDate } },
      select: { rank: true },
    }),
    prisma.revisionScreenRow.count({ where: { snapshotDate, ptRevOrthZ: { not: null } } }),
    getCompanyNamesByTicker(prisma, [ticker]).catch(() => new Map<string, string>()),
  ]);

  // ---- price tape ----
  const price: Array<{ date: string; close: number }> = [];
  if (security) {
    const bars = await prisma.priceHistory.findMany({
      where: { securityId: security.id, tradeDate: { gte: from, lte: snapshotDate } },
      select: { tradeDate: true, adjClose: true },
      orderBy: { tradeDate: "asc" },
    });
    for (const b of bars) {
      const c = Number(b.adjClose);
      if (Number.isFinite(c) && c > 0) price.push({ date: isoOf(b.tradeDate), close: c });
    }
  }

  // ---- meshed analyst panel (production dedup + supersession keys) ----
  const trSourced: SourcedPtEvent[] = trRows.map((r) => ({
    dateIso: isoOf(r.ratingDate),
    priceTarget: Number(r.priceTarget),
    source: "TIPRANKS",
    expertUID: r.expertUID,
    firm: r.firmName,
  }));
  const fmpSourced: SourcedPtEvent[] = fmpRows.map((r) => ({
    dateIso: isoOf(r.publishedDate),
    priceTarget: Number(r.priceTarget),
    source: "FMP",
    expertUID: null,
    firm: r.analystCompany,
  }));
  const meshed = meshPtSources(trSourced, fmpSourced);

  // Labels: the richest identity we saw for each supersession key.
  const labelByKey = new Map<string, { firm: string | null; analyst: string | null }>();
  const ratingByKeyDate = new Map<string, { rating: string | null; action: string | null }>();
  for (const r of trRows) {
    const key = r.expertUID ?? normalizeFirmName(r.firmName) ?? "";
    if (key) labelByKey.set(key, { firm: r.firmName, analyst: r.analystName });
    ratingByKeyDate.set(`${key}|${isoOf(r.ratingDate)}`, {
      rating: r.recommendation,
      action: r.analystAction,
    });
  }
  for (const r of fmpRows) {
    const key = normalizeFirmName(r.analystCompany) ?? "";
    if (key && !labelByKey.has(key)) labelByKey.set(key, { firm: r.analystCompany, analyst: r.analystName });
  }

  const byKey = new Map<string, Array<{ dateIso: string; pt: number; source: "TIPRANKS" | "FMP" }>>();
  for (const e of meshed.events) {
    const key = e.analyst ?? "unattributed";
    const arr = byKey.get(key);
    const step = { dateIso: e.dateIso, pt: e.priceTarget, source: e.source };
    if (arr) arr.push(step);
    else byKey.set(key, [step]);
  }

  const staleCutoff = isoOf(new Date(snapshotDate.getTime() - REVISION_THRESHOLDS.ptReconStaleDays * DAY_MS));
  const analysts: AnalystSeries[] = [];
  const events: NameEvent[] = [];
  for (const [key, raw] of byKey) {
    const sorted = [...raw].sort((a, b) => (a.dateIso < b.dateIso ? -1 : 1));
    const ident = labelByKey.get(key) ?? { firm: null, analyst: null };
    const steps: AnalystStep[] = [];
    let prev: number | null = null;
    for (const s of sorted) {
      const action = classify(prev, s.pt);
      const px = priceAt(price, s.dateIso);
      steps.push({ date: s.dateIso, target: s.pt, action, price: px });
      const meta = ratingByKeyDate.get(`${key}|${s.dateIso}`);
      events.push({
        date: s.dateIso,
        firm: ident.firm,
        analyst: ident.analyst,
        action,
        rating: meta?.rating ?? null,
        target: s.pt,
        prevTarget: prev,
        changePct: prev !== null && prev > 0 ? s.pt / prev - 1 : null,
        impliedUpside: px !== null && px > 0 ? s.pt / px - 1 : null,
        source: s.source,
      });
      prev = s.pt;
    }
    const sources = new Set(sorted.map((s) => s.source));
    analysts.push({
      key,
      label: ident.analyst ? `${ident.firm ?? "—"} · ${ident.analyst}` : ident.firm ?? key,
      stale: sorted[sorted.length - 1]!.dateIso < staleCutoff,
      source: sources.size > 1 ? "MIXED" : [...sources][0]!,
      steps,
    });
  }
  analysts.sort((a, b) => {
    const la = a.steps[a.steps.length - 1]!.date;
    const lb = b.steps[b.steps.length - 1]!.date;
    return la < lb ? 1 : la > lb ? -1 : 0;
  });
  events.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // ---- generated footer sentence ----
  const recentCutoff = isoOf(new Date(snapshotDate.getTime() - RECENT_RAISE_WEEKS * 7 * DAY_MS));
  const live = analysts.filter((a) => !a.stale);
  const raisedRecently = live.filter((a) =>
    a.steps.some((s) => s.date >= recentCutoff && s.action === "raise"),
  ).length;
  const staleCount = analysts.length - live.length;

  // ---- earnings dates ----
  const surprises = await prisma.earningsSurprise.findMany({
    where: { ticker, reportDate: { gte: from, lte: snapshotDate } },
    select: { reportDate: true },
    orderBy: { reportDate: "asc" },
  });
  const earningsDates = surprises.map((s) => isoOf(s.reportDate));
  const nextEarnings = row.daysToEarnings !== null
    ? isoOf(new Date(snapshotDate.getTime() + row.daysToEarnings * DAY_MS))
    : null;
  const nearPrint = earningsDates.some((d) => {
    const gap = Math.abs(new Date(`${d}T00:00:00Z`).getTime() - snapshotDate.getTime()) / DAY_MS;
    return gap <= 5;
  });
  const movedNearPrint = nearPrint
    ? events.filter((e) =>
        earningsDates.some(
          (d) =>
            Math.abs(new Date(`${e.date}T00:00:00Z`).getTime() - new Date(`${d}T00:00:00Z`).getTime()) /
              DAY_MS <=
            5,
        ),
      ).length
    : 0;
  const summary =
    `${raisedRecently} of ${live.length} raised in last ${RECENT_RAISE_WEEKS} wks · ` +
    `${movedNearPrint > 0 ? `${movedNearPrint}` : "none"} moved within 5 days of the print · ` +
    `${staleCount} stale`;

  // ---- small multiples ----
  const trailing = await prisma.revisionScreenRow.findMany({
    where: { ticker, snapshotDate: { lte: snapshotDate } },
    orderBy: { snapshotDate: "desc" },
    take: SMALL_MULTIPLE_WEEKS,
    select: { snapshotDate: true, ptUp: true, ptDown: true },
  });
  const weekDates = [...trailing].reverse().map((t) => t.snapshotDate);
  const weeks = weekDates.map(isoOf);
  const consensus = await prisma.revisionSnapshot.findMany({
    where: { ticker, snapshotDate: { in: weekDates } },
    select: { snapshotDate: true, epsAvg: true, revenueAvg: true, estimatesJson: true },
  });
  const consensusBy = new Map(consensus.map((c) => [isoOf(c.snapshotDate), c]));
  const secondPeriod = (json: unknown, metric: "eps" | "revenue"): number | null => {
    const annual = (json as { annual?: Array<Record<string, unknown>> } | null)?.annual;
    if (!Array.isArray(annual) || annual.length < 2) return null;
    const p = annual[annual.length - 1];
    const t = p?.[metric] as { avg?: unknown } | undefined;
    return typeof t?.avg === "number" && Number.isFinite(t.avg) ? t.avg : null;
  };
  const relReturn: Array<number | null> = [];
  const peerTickers = peersRaw.map((p) => p.ticker);
  const priceWeeks = await prisma.revisionPriceSnapshot.findMany({
    where: { ticker: { in: peerTickers }, snapshotDate: { in: weekDates } },
    select: { ticker: true, snapshotDate: true, ret1w: true },
  });
  const peerRetByWeek = new Map<string, number[]>();
  const ownRetByWeek = new Map<string, number>();
  for (const p of priceWeeks) {
    if (p.ret1w === null || !Number.isFinite(p.ret1w)) continue;
    const k = isoOf(p.snapshotDate);
    const arr = peerRetByWeek.get(k);
    if (arr) arr.push(p.ret1w);
    else peerRetByWeek.set(k, [p.ret1w]);
    if (p.ticker === ticker) ownRetByWeek.set(k, p.ret1w);
  }
  for (const w of weeks) {
    const own = ownRetByWeek.get(w);
    const peerArr = peerRetByWeek.get(w);
    relReturn.push(
      own !== undefined && peerArr && peerArr.length > 0
        ? own - peerArr.reduce((a, b) => a + b, 0) / peerArr.length
        : null,
    );
  }

  return {
    ticker,
    companyName: pickDisplayName(names, ticker, security?.name ?? null),
    snapshotDate: isoOf(snapshotDate),
    priorSnapshotDate: priorWeek ? isoOf(priorWeek.snapshotDate) : null,
    row: {
      ticker: row.ticker,
      companyName: pickDisplayName(names, ticker, security?.name ?? null),
      subsector: row.subsector,
      sector: row.sector,
      mktCap: row.mktCap,
      analystCount: row.analystCount,
      ptRevOrthZ: row.ptRevOrthZ,
      ptRevOrthRaw: row.ptRevOrthRaw,
      ptUp: row.ptUp,
      ptDown: row.ptDown,
      epsFy1Chg4w: row.epsFy1Chg4w,
      revFy1Chg4w: row.revFy1Chg4w,
      ratingUp: row.ratingUp,
      ratingDown: row.ratingDown,
      ratingInit: row.ratingInit,
      pxZ: row.pxZ,
      gap: row.gap,
      decile: row.decile,
      weeksInTopDecile: row.weeksInTopDecile,
      ptRevOrthZHist: row.ptRevOrthZHist,
      decileHist: row.decileHist,
      isNewTop: row.isNewTop,
      isNewBottom: row.isNewBottom,
      daysToEarnings: row.daysToEarnings,
      grpZ: row.grpZ,
      idioZ: row.idioZ,
      e2Tag: row.e2Tag,
      e3Tag: row.e3Tag,
      e4Tag: row.e4Tag,
    },
    rank: rankRow?.rank ?? null,
    universeSize,
    panel: {
      price,
      earningsDates,
      nextEarnings,
      analysts,
      summary,
      staleDays: REVISION_THRESHOLDS.ptReconStaleDays,
    },
    peers: peersRaw.map((p) => ({ ticker: p.ticker, ptRevOrthZ: p.ptRevOrthZ! })),
    smallMultiples: {
      weeks,
      epsFy1: weeks.map((w) => {
        const v = consensusBy.get(w)?.epsAvg;
        return v === null || v === undefined ? null : Number(v);
      }),
      epsFy2: weeks.map((w) => secondPeriod(consensusBy.get(w)?.estimatesJson, "eps")),
      revFy1: weeks.map((w) => {
        const v = consensusBy.get(w)?.revenueAvg;
        return v === null || v === undefined ? null : Number(v);
      }),
      revFy2: weeks.map((w) => secondPeriod(consensusBy.get(w)?.estimatesJson, "revenue")),
      ptUp: [...trailing].reverse().map((t) => t.ptUp),
      ptDown: [...trailing].reverse().map((t) => t.ptDown),
      relReturn,
    },
    events: events.slice(0, EVENT_LOG_LIMIT),
  };
}
