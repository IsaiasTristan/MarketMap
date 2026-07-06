/**
 * Overview SIGNAL BRIEF — the composing read service behind
 * GET /api/analysis/portfolio/signal-brief.
 *
 * Joins the portfolio's tickers (canonical weights via loadPortfolioWeights —
 * the same PortfolioPosition source + |shares×price|/Σ derivation the Holdings
 * table renders) onto data the revision + institutional engines already
 * precompute, then applies the pure verdict/severity rules
 * (@/lib/analysis/signal-brief/rules). Read-only composition: no new scoring,
 * no new tables. Every leg degrades independently — missing 13F coverage,
 * sparse revision history, or an empty transition set each leave the other
 * modules intact.
 */
import { prisma } from "@/infrastructure/db/client";
import { loadPortfolioWeights } from "@/server/services/portfolio.service";
import {
  getCalendar,
  getLatestScoresForTickers,
  getLatestTransitions,
  getNextEarningsForTickers,
  type LatestTransitionRow,
} from "@/server/services/revision/revision-query.service";
import {
  getEventsForTickers,
  getNameAggregatesForTickers,
  getOverview,
  type TickerFlowEvent,
} from "@/server/services/institutional/institutional-query.service";
import {
  SIGNAL_BRIEF_THRESHOLDS,
  type SignalBriefThresholds,
} from "@/lib/analysis/signal-brief/config";
import {
  buildFeed,
  classifyVerdict,
  isCrowdedDistributing,
  qualifiesStasisBreak,
  type FeedCandidate,
  type Verdict,
} from "@/lib/analysis/signal-brief/rules";

// ─── payload contract (the client type-imports these) ───────────────────────

export interface ScatterPointDto {
  ticker: string;
  /** Gross portfolio weight fraction (0..1). */
  weight: number;
  isShort: boolean;
  gapScore: number;
  netflowBps: number;
  verdict: Verdict;
}

export interface EarningsItemDto {
  ticker: string;
  erDate: string;
  days: number;
  /** Held names carry weight; queue names carry side. */
  held: boolean;
  weight: number | null;
  side: string | null;
}

export interface FeedRowDto {
  source: "REV" | "13F";
  ticker: string | null;
  held: boolean;
  weight: number | null;
  kind: string;
  sentence: string;
  positive: boolean;
  date: string;
  href: string;
}

export interface SignalBriefPayload {
  generatedAt: string;
  asOf: {
    /** Latest revision score snapshot (null while accruing). */
    revisionSnapshotDate: string | null;
    /** Accruing-window state from the baked queue payload, when exposed. */
    effectiveWindow: { legAWeeks: number; composite4wWindow: number } | null;
    /** Latest filed 13F quarter end (yyyy-MM-dd), null with no coverage. */
    flowPeriod: string | null;
  };
  scatter: {
    points: ScatterPointDto[];
    /** Held names missing a leg — footnoted, never plotted at fabricated zeros. */
    noCoverage: string[];
  };
  earnings: {
    windowDays: number;
    items: EarningsItemDto[];
    /** Held names not yet onboarded into the research universe (no ER date stored). */
    noDate: string[];
  };
  feed: {
    rows: FeedRowDto[];
    /** The transition-set date the feed describes ("no changes since <date>"). */
    sinceDate: string | null;
  };
}

// ─── sentence + link helpers ─────────────────────────────────────────────────

const pctBps = (v: number): string => `${v >= 0 ? "+" : ""}${Math.round(v)}bps`;

function stageTransitionSentence(e: TickerFlowEvent): string {
  const from = e.from ?? "—";
  const to = e.to ?? "—";
  return `FLOW LIFECYCLE ${from} → ${to}`;
}

function stasisSentence(e: TickerFlowEvent, baseRate: string | null): string {
  const who =
    e.departed !== null && e.priorLongHolders !== null
      ? ` — ${e.departed}/${e.priorLongHolders} LONG HOLDERS DEPARTED`
      : "";
  return `CORE-HOLDER STASIS BREAK${who}${baseRate ? ` · ${baseRate}` : ""}`;
}

/** Positive stage destinations (accumulation strengthening). */
const POSITIVE_STAGES = new Set(["FORMING", "DURABLE", "CORE"]);

// ─── the composing read ──────────────────────────────────────────────────────

export async function getSignalBrief(
  portfolioId: string,
  t: SignalBriefThresholds = SIGNAL_BRIEF_THRESHOLDS,
): Promise<SignalBriefPayload | null> {
  const weights = await loadPortfolioWeights(prisma, portfolioId);
  const held = weights.filter((w) => !w.isCash);
  if (held.length === 0) return null;

  const heldTickers = held.map((h) => h.ticker);
  const weightByTicker = new Map(held.map((h) => [h.ticker, h.grossWeight]));
  const isShortByTicker = new Map(held.map((h) => [h.ticker, h.isShort]));
  const heldSet = new Set(heldTickers);

  // Fan out to the two engines' read layers; each leg degrades independently.
  const [scores, transitions, earnings, calendar, aggs, events, overview] = await Promise.all([
    getLatestScoresForTickers(heldTickers).catch(() => ({
      snapshotDate: null,
      effectiveWindow: null,
      scores: [],
    })),
    getLatestTransitions().catch(() => ({ snapshotDate: null, rows: [] })),
    getNextEarningsForTickers(heldTickers, t.earningsWindowDays).catch(() => ({
      rows: [],
      coveredTickers: [] as string[],
    })),
    getCalendar(t.earningsWindowDays).catch(() => null),
    getNameAggregatesForTickers(heldTickers).catch(() => ({ filingPeriod: null, rows: [] })),
    getEventsForTickers(heldTickers).catch(() => ({
      filingPeriod: null,
      events: [],
      stasisBaseRate: null,
    })),
    getOverview().catch(() => null),
  ]);

  const scoreByTicker = new Map(scores.scores.map((s) => [s.ticker, s]));
  const aggByTicker = new Map(aggs.rows.map((a) => [a.ticker, a]));
  const transByTicker = new Map<string, LatestTransitionRow[]>();
  for (const row of transitions.rows) {
    if (!row.ticker) continue;
    const list = transByTicker.get(row.ticker) ?? [];
    list.push(row);
    transByTicker.set(row.ticker, list);
  }
  const eventsByTicker = new Map<string, TickerFlowEvent[]>();
  for (const e of events.events) {
    const list = eventsByTicker.get(e.ticker) ?? [];
    list.push(e);
    eventsByTicker.set(e.ticker, list);
  }

  // ── 1. Scatter: verdict per held name; both legs required to plot. ──
  const points: ScatterPointDto[] = [];
  const noCoverage: string[] = [];
  for (const h of held) {
    const score = scoreByTicker.get(h.ticker);
    const agg = aggByTicker.get(h.ticker);
    const tickerTrans = transByTicker.get(h.ticker) ?? [];
    const tickerEvents = eventsByTicker.get(h.ticker) ?? [];
    const verdict = classifyVerdict(
      {
        gapScore: score?.gapScore ?? null,
        netflowBps: agg?.netflowBps ?? null,
        positiveTransition: tickerTrans.some((x) => x.type === "NEW_LONG"),
        negativeTransition: tickerTrans.some((x) => x.type === "NEW_SHORT"),
        stasisBreak: tickerEvents.some(
          (e) => e.kind === "stasis_break" && qualifiesStasisBreak(e.significance, t),
        ),
        crowdedDistributing: isCrowdedDistributing(agg?.quadrant ?? null, agg?.deltaHolders ?? null),
      },
      t,
    );
    if (score?.gapScore != null && agg?.netflowBps != null) {
      points.push({
        ticker: h.ticker,
        weight: h.grossWeight,
        isShort: h.isShort,
        gapScore: score.gapScore,
        netflowBps: agg.netflowBps,
        verdict,
      });
    } else {
      noCoverage.push(h.ticker);
    }
  }

  // ── 2. Earnings timeline: held prints (always) + queue names reporting. ──
  const items: EarningsItemDto[] = earnings.rows.map((r) => ({
    ticker: r.ticker,
    erDate: r.erDate,
    days: r.days,
    held: true,
    weight: weightByTicker.get(r.ticker) ?? null,
    side: isShortByTicker.get(r.ticker) ? "SHORT" : "LONG",
  }));
  if (calendar) {
    for (const week of calendar.weeks) {
      for (const row of week.rows) {
        if (row.side == null || heldSet.has(row.ticker)) continue; // queue names only; held already listed
        items.push({
          ticker: row.ticker,
          erDate: row.erDate,
          days: row.days,
          held: false,
          weight: null,
          side: row.side,
        });
      }
    }
  }
  items.sort((a, b) => a.days - b.days || a.ticker.localeCompare(b.ticker));
  const noDate = heldTickers.filter((x) => !earnings.coveredTickers.includes(x));

  // ── 3. What-changed feed: merge both engines' events, severity-rule sort. ──
  const candidates: FeedCandidate[] = [];
  for (const row of transitions.rows) {
    if (!row.ticker) continue; // group-level REV triggers stay on the Research tab
    if (row.type === "ER_WITHIN_7D") continue; // the timeline module owns prints
    const isHeld = heldSet.has(row.ticker);
    const gap = typeof row.payload.gapScore === "number" ? row.payload.gapScore : null;
    if (!isHeld && row.type !== "NEW_LONG" && row.type !== "NEW_SHORT") continue; // non-held: new ideas only
    candidates.push({
      source: "REV",
      ticker: row.ticker,
      held: isHeld,
      weight: isHeld ? (weightByTicker.get(row.ticker) ?? null) : null,
      positive: row.type === "NEW_LONG" || row.type === "NEXT_DOMINO",
      kind: row.type,
      sentence: row.reason,
      severity: gap !== null ? Math.abs(gap) : 1,
      date: row.snapshotDate,
      href: `/research?tab=queue&ticker=${row.ticker}`,
      gapScore: gap,
    });
  }
  for (const e of events.events) {
    if (e.kind === "stasis_break") {
      if (!qualifiesStasisBreak(e.significance, t)) continue;
      candidates.push({
        source: "13F",
        ticker: e.ticker,
        held: true,
        weight: weightByTicker.get(e.ticker) ?? null,
        positive: false,
        kind: e.kind,
        sentence: stasisSentence(e, events.stasisBaseRate),
        severity: e.significance,
        date: e.filingPeriod,
        href: `/flows?tab=trajectories&ticker=${e.ticker}`,
      });
    } else if (e.kind === "stage_transition") {
      candidates.push({
        source: "13F",
        ticker: e.ticker,
        held: true,
        weight: weightByTicker.get(e.ticker) ?? null,
        positive: e.to !== null && POSITIVE_STAGES.has(e.to),
        kind: e.kind,
        sentence: stageTransitionSentence(e),
        severity: e.significance,
        date: e.filingPeriod,
        href: `/flows?tab=trajectories&ticker=${e.ticker}`,
      });
    }
  }
  // Strongest non-held new flow idea: the quarter's broadest new accumulation.
  const topNew = overview?.topNew?.[0];
  if (topNew && !heldSet.has(topNew.ticker)) {
    candidates.push({
      source: "13F",
      ticker: topNew.ticker,
      held: false,
      weight: null,
      positive: true,
      kind: "NEW_ACCUMULATION",
      sentence: `BROADEST NEW ACCUMULATION — ${topNew.fundsBought} FUNDS BOUGHT VS ${topNew.fundsSold} SOLD`,
      severity: topNew.fundsBought,
      date: overview?.filingPeriod ?? "",
      href: `/flows?tab=overview&ticker=${topNew.ticker}`,
    });
  }
  // The single most extreme group rotation move (extremity-gated in buildFeed).
  const rot = overview?.rotation;
  if (rot) {
    const tiles = [rot.broadestInflow, rot.broadestOutflow].filter(
      (x): x is NonNullable<typeof x> => x != null,
    );
    const extreme = tiles.sort((a, b) => Math.abs(b.netDiffusionPct) - Math.abs(a.netDiffusionPct))[0];
    if (extreme) {
      candidates.push({
        source: "13F",
        ticker: null,
        held: false,
        weight: null,
        positive: extreme.netDiffusionPct > 0,
        kind: "GROUP_ROTATION",
        sentence: `${extreme.groupKey.toUpperCase()} — BROADEST ${extreme.netDiffusionPct > 0 ? "INFLOW" : "OUTFLOW"} (${extreme.netDiffusionPct > 0 ? "+" : ""}${Math.round(extreme.netDiffusionPct)}% NET DIFFUSION, ${pctBps(extreme.activeBpsAvg)}/FUND)`,
        severity: Math.abs(extreme.netDiffusionPct),
        date: overview?.filingPeriod ?? "",
        href: `/flows?tab=rotation`,
        isRotation: true,
      });
    }
  }

  const feedRows: FeedRowDto[] = buildFeed(candidates, t).map((c) => ({
    source: c.source,
    ticker: c.ticker,
    held: c.held,
    weight: c.weight,
    kind: c.kind,
    sentence: c.sentence,
    positive: c.positive,
    date: c.date,
    href: c.href,
  }));

  return {
    generatedAt: new Date().toISOString(),
    asOf: {
      revisionSnapshotDate: scores.snapshotDate,
      effectiveWindow: scores.effectiveWindow,
      flowPeriod: aggs.filingPeriod,
    },
    scatter: { points, noCoverage },
    earnings: { windowDays: t.earningsWindowDays, items, noDate },
    feed: { rows: feedRows, sinceDate: transitions.snapshotDate },
  };
}
