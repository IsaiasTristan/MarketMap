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
  getHeldEarnings,
  getLatestScoresForTickers,
  getLatestTransitions,
  getPrevScoresForTickers,
  type LatestTransitionRow,
} from "@/server/services/revision/revision-query.service";
import { getLatestFundamentalScoresForTickers } from "@/server/services/fundamental/fundamental-query.service";
import { getCompanyNamesByTicker } from "@/server/services/security-name.service";
import {
  getEventsForTickers,
  getNameAggregatesForTickers,
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
  /** Any axis metric is null when that leg has no coverage — never fabricate 0.
   *  Each scatter plots only the names carrying BOTH of its two axes. */
  gapScore: number | null;
  netflowBps: number | null;
  /** Engine-2 inflection composite (z-scored). */
  inflection: number | null;
  verdict: Verdict;
}

export interface EarningsItemDto {
  ticker: string;
  companyName: string | null;
  /** Null when no upcoming print is stored for the name. */
  erDate: string | null;
  days: number | null;
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
  /** Current + prior gap for the delta annotation (REV rows only). */
  gapScore?: number | null;
  prevGapScore?: number | null;
  /** Calendar days between the current and prior revision snapshot. */
  prevGapDays?: number | null;
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
    /** Every held name with whatever legs it carries; each chart filters to the
     *  names holding BOTH its axes and footnotes the rest. */
    points: ScatterPointDto[];
  };
  earnings: {
    items: EarningsItemDto[];
    /** Held names not yet onboarded into the research universe (no ER row at all). */
    noDate: string[];
  };
  feed: {
    rows: FeedRowDto[];
    /** The transition-set date the feed describes ("no changes since <date>"). */
    sinceDate: string | null;
  };
}

// ─── sentence + link helpers ─────────────────────────────────────────────────

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

  // Fan out to the engines' read layers; each leg degrades independently.
  const [scores, prevScores, fundamentals, transitions, earnings, aggs, events, companyNames] =
    await Promise.all([
      getLatestScoresForTickers(heldTickers).catch(() => ({
        snapshotDate: null,
        effectiveWindow: null,
        scores: [],
      })),
      getPrevScoresForTickers(heldTickers).catch(() => ({ snapshotDate: null, gapByTicker: new Map<string, number>() })),
      getLatestFundamentalScoresForTickers(heldTickers).catch(() => ({ snapshotDate: null, scores: [] })),
      getLatestTransitions().catch(() => ({ snapshotDate: null, rows: [] })),
      getHeldEarnings(heldTickers).catch(() => ({ rows: [], coveredTickers: [] as string[] })),
      getNameAggregatesForTickers(heldTickers).catch(() => ({ filingPeriod: null, rows: [] })),
      getEventsForTickers(heldTickers).catch(() => ({
        filingPeriod: null,
        events: [],
        stasisBaseRate: null,
      })),
      getCompanyNamesByTicker(prisma, heldTickers).catch(() => new Map<string, string>()),
    ]);

  const scoreByTicker = new Map(scores.scores.map((s) => [s.ticker, s]));
  const inflectionByTicker = new Map(fundamentals.scores.map((s) => [s.ticker, s.composite]));
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

  // ── 1. Scatter: one point per held name carrying whatever legs it has (gap,
  //       13F flow, inflection). Each chart filters to its two axes; the verdict
  //       (book-level agreement) drives dot color consistently across all three. ──
  const points: ScatterPointDto[] = [];
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
    points.push({
      ticker: h.ticker,
      weight: h.grossWeight,
      isShort: h.isShort,
      gapScore: score?.gapScore ?? null,
      netflowBps: agg?.netflowBps ?? null,
      inflection: inflectionByTicker.get(h.ticker) ?? null,
      verdict,
    });
  }

  // ── 2. Earnings table: the whole book, ordered by next print. Names with no
  //       upcoming date sort last (erDate=null). ──
  const items: EarningsItemDto[] = earnings.rows.map((r) => ({
    ticker: r.ticker,
    companyName: companyNames.get(r.ticker) ?? null,
    erDate: r.erDate,
    days: r.days,
    weight: weightByTicker.get(r.ticker) ?? null,
    side: isShortByTicker.get(r.ticker) ? "SHORT" : "LONG",
  }));
  items.sort((a, b) => {
    if (a.days == null && b.days == null) return a.ticker.localeCompare(b.ticker);
    if (a.days == null) return 1;
    if (b.days == null) return -1;
    return a.days - b.days || a.ticker.localeCompare(b.ticker);
  });
  const noDate = heldTickers.filter((x) => !earnings.coveredTickers.includes(x));

  // ── 3. What-changed feed: merge both engines' events, severity-rule sort. ──
  const candidates: FeedCandidate[] = [];
  for (const row of transitions.rows) {
    if (!row.ticker) continue; // group-level REV triggers stay on the Research tab
    if (row.type === "ER_WITHIN_7D") continue; // the timeline module owns prints
    const isHeld = heldSet.has(row.ticker);
    if (!isHeld) continue; // holdings-only feed — no non-held "new idea" rows
    const gap = typeof row.payload.gapScore === "number" ? row.payload.gapScore : null;
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
  // Calendar-day span between the current and prior revision snapshot, used to
  // label the prev-gap annotation ("prev 5d: …"). Same for every REV row.
  const prevGapDays =
    transitions.snapshotDate && prevScores.snapshotDate
      ? Math.round(
          (new Date(`${transitions.snapshotDate}T00:00:00Z`).getTime() -
            new Date(`${prevScores.snapshotDate}T00:00:00Z`).getTime()) /
            86_400_000,
        )
      : null;

  const feedRows: FeedRowDto[] = buildFeed(candidates, t).map((c) => {
    const isRev = c.source === "REV" && c.ticker != null;
    const prevGapScore = isRev ? (prevScores.gapByTicker.get(c.ticker!) ?? null) : null;
    return {
      source: c.source,
      ticker: c.ticker,
      held: c.held,
      weight: c.weight,
      kind: c.kind,
      sentence: c.sentence,
      positive: c.positive,
      date: c.date,
      href: c.href,
      gapScore: isRev ? (c.gapScore ?? null) : null,
      prevGapScore,
      prevGapDays: prevGapScore != null ? prevGapDays : null,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    asOf: {
      revisionSnapshotDate: scores.snapshotDate,
      effectiveWindow: scores.effectiveWindow,
      flowPeriod: aggs.filingPeriod,
    },
    scatter: { points },
    earnings: { items, noDate },
    feed: { rows: feedRows, sinceDate: transitions.snapshotDate },
  };
}
