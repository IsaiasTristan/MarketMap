/**
 * Engine 1 — TipRanks sweep (FMP paid add-on) into TipRanksRatingEvent.
 *
 * One call per ticker at the full-history limit; a response that hits the
 * limit is page-walked so history is never silently truncated. Idempotent:
 * existing natural keys for the ticker are loaded first and filtered out
 * (Postgres NULLs do not collide in unique constraints, so createMany
 * skipDuplicates alone would re-insert null-PT / null-analyst rows). Progress
 * lands in TipRanksIngestLedger per ticker so a crash, a burst 429, or a
 * lapsed subscription resumes without re-billing calls.
 *
 * An FmpEntitlementError (HTTP 402) aborts the sweep immediately — the add-on
 * is off — and is reported, not thrown, so daily tails no-op cleanly.
 */
import type { Prisma, TipRanksProvenance } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import {
  FmpEntitlementError,
  fetchTipRanksAnalyst,
  fetchTipRanksRatings,
  fmpPool,
  TIPRANKS_FULL_HISTORY_LIMIT,
  type NormalizedTipRanksRating,
} from "@/infrastructure/providers/fmp";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_GAP_MS = 800; // ~4 workers -> ~200-250 calls/min, well under the 3,000 ceiling
const MAX_PAGES = 50;

export interface TipRanksSweepOptions {
  tickers?: string[];
  /** Inclusive lower bound (YYYY-MM-DD). Omit for the full available history. */
  from?: string;
  /** Skip tickers whose ledger row is already COMPLETE. */
  resume?: boolean;
  provenance?: TipRanksProvenance;
  concurrency?: number;
  gapMs?: number;
  log?: (msg: string) => void;
}

export interface TipRanksSweepSummary {
  entitled: boolean;
  tickers: number;
  attempted: number;
  completed: number;
  failed: number;
  rowsFetched: number;
  rowsWritten: number;
  hitLimit: string[];
  failures: Array<{ ticker: string; error: string }>;
}

/**
 * Every ticker we have ever tracked: active + inactive references, plus any
 * ticker with price-target history from either source (survivorship-safe).
 */
export async function loadTipRanksSweepTickers(): Promise<string[]> {
  const [refs, fmpPt, tr] = await Promise.all([
    prisma.revisionReference.findMany({ select: { ticker: true } }),
    prisma.priceTargetEvent.findMany({ distinct: ["ticker"], select: { ticker: true } }),
    prisma.tipRanksRatingEvent.findMany({ distinct: ["ticker"], select: { ticker: true } }),
  ]);
  const set = new Set<string>();
  for (const r of [...refs, ...fmpPt, ...tr]) set.add(r.ticker.toUpperCase());
  return [...set].sort();
}

function keyOf(ratingDate: string, expertUID: string | null, priceTarget: number | null): string {
  return `${ratingDate}|${expertUID ?? ""}|${priceTarget === null ? "" : priceTarget.toFixed(6)}`;
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Fetch a ticker's full history, page-walking when a page hits the limit. */
async function fetchAllPages(
  ticker: string,
  from: string | undefined,
): Promise<{ rows: NormalizedTipRanksRating[]; pages: number; hitLimit: boolean }> {
  const limit = TIPRANKS_FULL_HISTORY_LIMIT;
  const rows: NormalizedTipRanksRating[] = [];
  let pages = 0;
  let hitLimit = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await fetchTipRanksRatings(ticker, { from, limit, page: page === 0 ? undefined : page });
    pages++;
    rows.push(...batch);
    if (batch.length < limit) break;
    hitLimit = true;
  }
  return { rows, pages, hitLimit };
}

async function persistTicker(
  ticker: string,
  rows: NormalizedTipRanksRating[],
  provenance: TipRanksProvenance,
): Promise<number> {
  if (rows.length === 0) return 0;
  const existing = await prisma.tipRanksRatingEvent.findMany({
    where: { ticker },
    select: { ratingDate: true, expertUID: true, priceTarget: true },
  });
  const seen = new Set(
    existing.map((e) =>
      keyOf(isoOf(e.ratingDate), e.expertUID, e.priceTarget === null ? null : Number(e.priceTarget)),
    ),
  );
  const data: Prisma.TipRanksRatingEventCreateManyInput[] = [];
  for (const r of rows) {
    const k = keyOf(r.ratingDate, r.expertUID, r.priceTarget);
    if (seen.has(k)) continue;
    seen.add(k);
    data.push({
      ticker,
      ratingDate: new Date(`${r.ratingDate}T00:00:00Z`),
      publishedAt: r.publishedAt ? new Date(r.publishedAt) : null,
      expertUID: r.expertUID,
      analystName: r.analystName,
      firmName: r.firmName,
      recommendation: r.recommendation,
      analystAction: r.analystAction,
      priceTarget: r.priceTarget ?? undefined,
      priceTargetCurrency: r.priceTargetCurrency,
      articleTitle: r.articleTitle,
      articleSite: r.articleSite,
      url: r.url,
      rawJson: r.raw as unknown as Prisma.InputJsonValue,
      provenance,
    });
  }
  if (data.length === 0) return 0;
  const res = await prisma.tipRanksRatingEvent.createMany({ data, skipDuplicates: true });
  return res.count;
}

/** Resumable per-ticker sweep of TipRanks ratings into TipRanksRatingEvent. */
export async function sweepTipRanksRatings(opts: TipRanksSweepOptions = {}): Promise<TipRanksSweepSummary> {
  const log = opts.log ?? (() => {});
  const provenance: TipRanksProvenance = opts.provenance ?? (opts.from ? "LIVE" : "BACKFILL");
  const all = opts.tickers?.map((t) => t.toUpperCase()) ?? (await loadTipRanksSweepTickers());

  let todo = all;
  if (opts.resume) {
    const done = await prisma.tipRanksIngestLedger.findMany({
      where: { ticker: { in: all }, status: "COMPLETE" },
      select: { ticker: true },
    });
    const doneSet = new Set(done.map((d) => d.ticker));
    todo = all.filter((t) => !doneSet.has(t));
    log(`[tipranks] resume: ${doneSet.size} already complete, ${todo.length} to go`);
  }

  const summary: TipRanksSweepSummary = {
    entitled: true,
    tickers: all.length,
    attempted: 0,
    completed: 0,
    failed: 0,
    rowsFetched: 0,
    rowsWritten: 0,
    hitLimit: [],
    failures: [],
  };
  if (todo.length === 0) return summary;

  let aborted = false;
  let processed = 0;
  await fmpPool(
    todo,
    async (ticker) => {
      if (aborted) return;
      summary.attempted++;
      try {
        const { rows, pages, hitLimit } = await fetchAllPages(ticker, opts.from);
        const written = await persistTicker(ticker, rows, provenance);
        const dates = rows.map((r) => r.ratingDate).sort();
        await prisma.tipRanksIngestLedger.upsert({
          where: { ticker },
          create: {
            ticker,
            status: "COMPLETE",
            rowsFetched: rows.length,
            rowsWritten: written,
            pagesFetched: pages,
            hitLimit,
            minRatingDate: dates.length ? new Date(`${dates[0]}T00:00:00Z`) : null,
            maxRatingDate: dates.length ? new Date(`${dates[dates.length - 1]}T00:00:00Z`) : null,
            lastError: null,
            attempts: 1,
            completedAt: new Date(),
          },
          update: {
            status: "COMPLETE",
            rowsFetched: rows.length,
            rowsWritten: written,
            pagesFetched: pages,
            hitLimit,
            ...(dates.length
              ? {
                  minRatingDate: new Date(`${dates[0]}T00:00:00Z`),
                  maxRatingDate: new Date(`${dates[dates.length - 1]}T00:00:00Z`),
                }
              : {}),
            lastError: null,
            attempts: { increment: 1 },
            completedAt: new Date(),
          },
        });
        summary.completed++;
        summary.rowsFetched += rows.length;
        summary.rowsWritten += written;
        if (hitLimit) summary.hitLimit.push(ticker);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof FmpEntitlementError) {
          aborted = true;
          summary.entitled = false;
          log(`[tipranks] NOT ENTITLED (HTTP 402) — add-on inactive; aborting sweep at ${ticker}`);
          return;
        }
        summary.failed++;
        summary.failures.push({ ticker, error: msg });
        await prisma.tipRanksIngestLedger.upsert({
          where: { ticker },
          create: { ticker, status: "FAILED", lastError: msg.slice(0, 500), attempts: 1 },
          update: { status: "FAILED", lastError: msg.slice(0, 500), attempts: { increment: 1 } },
        });
      } finally {
        processed++;
        if (processed % 100 === 0)
          log(`[tipranks] ${processed}/${todo.length} · rows +${summary.rowsWritten} · failed ${summary.failed}`);
      }
    },
    { concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY, gapMs: opts.gapMs ?? DEFAULT_GAP_MS },
  );

  log(
    `[tipranks] sweep done: ${summary.completed}/${summary.attempted} tickers, +${summary.rowsWritten} rows ` +
      `(${summary.rowsFetched} fetched), ${summary.failed} failed, ${summary.hitLimit.length} hit limit` +
      (summary.entitled ? "" : " — ABORTED: not entitled"),
  );
  return summary;
}

export interface TipRanksAnalystSweepSummary {
  entitled: boolean;
  candidates: number;
  resolved: number;
  unresolved: number;
  failed: number;
}

/**
 * Resolve the analyst directory for every distinct analystName seen in the
 * swept ratings that has no TipRanksAnalyst row yet. Exact-name lookup, so
 * some names legitimately return nothing; those are counted, not retried.
 */
export async function sweepTipRanksAnalysts(
  opts: { concurrency?: number; gapMs?: number; log?: (msg: string) => void } = {},
): Promise<TipRanksAnalystSweepSummary> {
  const log = opts.log ?? (() => {});
  const [names, known] = await Promise.all([
    prisma.tipRanksRatingEvent.findMany({
      where: { expertUID: { not: null }, analystName: { not: null } },
      distinct: ["expertUID"],
      select: { expertUID: true, analystName: true },
    }),
    prisma.tipRanksAnalyst.findMany({ select: { expertUID: true } }),
  ]);
  const knownSet = new Set(known.map((k) => k.expertUID));
  const pending = new Map<string, string>(); // analystName -> one expertUID (lookup is by name)
  for (const n of names) {
    if (!n.expertUID || !n.analystName || knownSet.has(n.expertUID)) continue;
    if (!pending.has(n.analystName)) pending.set(n.analystName, n.expertUID);
  }
  const candidates = [...pending.keys()];
  log(`[tipranks-analysts] ${candidates.length} analyst names to resolve (${knownSet.size} already known)`);

  const summary: TipRanksAnalystSweepSummary = {
    entitled: true,
    candidates: candidates.length,
    resolved: 0,
    unresolved: 0,
    failed: 0,
  };
  if (candidates.length === 0) return summary;

  let aborted = false;
  let processed = 0;
  await fmpPool(
    candidates,
    async (name) => {
      if (aborted) return;
      try {
        const rows = await fetchTipRanksAnalyst(name);
        if (rows.length === 0) {
          summary.unresolved++;
          return;
        }
        for (const a of rows) {
          await prisma.tipRanksAnalyst.upsert({
            where: { expertUID: a.expertUID },
            create: {
              expertUID: a.expertUID,
              analystName: a.analystName,
              firmName: a.firmName,
              successRate: a.successRate,
              excessReturn: a.excessReturn,
              totalRecommendations: a.totalRecommendations,
              goodRecommendations: a.goodRecommendations,
              analystRank: a.analystRank,
              numOfStars: a.numOfStars,
              rawJson: a.raw as unknown as Prisma.InputJsonValue,
            },
            update: {
              analystName: a.analystName,
              firmName: a.firmName,
              successRate: a.successRate,
              excessReturn: a.excessReturn,
              totalRecommendations: a.totalRecommendations,
              goodRecommendations: a.goodRecommendations,
              analystRank: a.analystRank,
              numOfStars: a.numOfStars,
              rawJson: a.raw as unknown as Prisma.InputJsonValue,
              fetchedAt: new Date(),
            },
          });
          summary.resolved++;
        }
      } catch (e) {
        if (e instanceof FmpEntitlementError) {
          aborted = true;
          summary.entitled = false;
          log(`[tipranks-analysts] NOT ENTITLED (HTTP 402); aborting`);
          return;
        }
        summary.failed++;
      } finally {
        processed++;
        if (processed % 250 === 0) log(`[tipranks-analysts] ${processed}/${candidates.length} · resolved ${summary.resolved}`);
      }
    },
    { concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY, gapMs: opts.gapMs ?? DEFAULT_GAP_MS },
  );
  log(
    `[tipranks-analysts] done: resolved ${summary.resolved}, unresolved ${summary.unresolved}, failed ${summary.failed}` +
      (summary.entitled ? "" : " — ABORTED: not entitled"),
  );
  return summary;
}

const TAIL_OVERLAP_DAYS = 7; // re-read a week behind the high-water mark to catch late-posted rows (dedup absorbs the overlap)

export interface TipRanksTailSummary {
  entitled: boolean;
  skipped: string | null;
  rowsWritten: number;
  failed: number;
}

/**
 * Daily tail while entitled: re-sweep every active ticker from
 * (high-water mark − overlap) with LIVE provenance. When the add-on is off the
 * first call returns 402 and the tail no-ops (one billed call, one log line) —
 * so re-subscribing needs no code change: the next daily run resumes from the
 * ledger's high-water mark and re-densifies the gap. Never throws.
 */
export async function tailTipRanksDaily(
  tickers: string[],
  opts: { log?: (msg: string) => void } = {},
): Promise<TipRanksTailSummary> {
  const log = opts.log ?? (() => {});
  const agg = await prisma.tipRanksIngestLedger.aggregate({ _max: { maxRatingDate: true } });
  const hwm = agg._max.maxRatingDate;
  if (!hwm) {
    log("[tipranks] no backfill high-water mark; skipping daily tail (run job:tipranks-backfill first)");
    return { entitled: true, skipped: "no-high-water-mark", rowsWritten: 0, failed: 0 };
  }
  const from = isoOf(new Date(hwm.getTime() - TAIL_OVERLAP_DAYS * 86_400_000));
  try {
    const s = await sweepTipRanksRatings({ tickers, from, provenance: "LIVE", log });
    return { entitled: s.entitled, skipped: null, rowsWritten: s.rowsWritten, failed: s.failed };
  } catch (e) {
    log(`[tipranks] daily tail failed: ${e instanceof Error ? e.message : String(e)}`);
    return { entitled: true, skipped: "error", rowsWritten: 0, failed: tickers.length };
  }
}

/** Ledger roll-up for reporting + the cancellation gate. */
export async function tipRanksLedgerStatus(): Promise<{
  complete: number;
  failed: number;
  pending: number;
  hitLimit: string[];
  highWaterMark: string | null;
  earliest: string | null;
  rows: number;
}> {
  const [byStatus, hit, agg, rows] = await Promise.all([
    prisma.tipRanksIngestLedger.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.tipRanksIngestLedger.findMany({ where: { hitLimit: true }, select: { ticker: true } }),
    prisma.tipRanksIngestLedger.aggregate({ _max: { maxRatingDate: true }, _min: { minRatingDate: true } }),
    prisma.tipRanksRatingEvent.count(),
  ]);
  const count = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
  return {
    complete: count("COMPLETE"),
    failed: count("FAILED"),
    pending: count("PENDING"),
    hitLimit: hit.map((h) => h.ticker),
    highWaterMark: agg._max.maxRatingDate ? isoOf(agg._max.maxRatingDate) : null,
    earliest: agg._min.minRatingDate ? isoOf(agg._min.minRatingDate) : null,
    rows,
  };
}
