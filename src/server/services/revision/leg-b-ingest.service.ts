/**
 * Engine 1 — Leg B (ratings / price-targets). Two paths:
 *  - Weekly consensus (per-symbol, scoped to our universe via the worker pool):
 *    current rating distribution + price-target consensus (high/low/median/
 *    consensus) -> per-ticker part. We scope to our ~universe rather than the
 *    bulk global file, whose non-profile downloads are throttled to ~1/10s and
 *    paginate into many slow parts.
 *  - Event backfill (per-symbol, first run / on demand): full point-in-time
 *    grade-change and price-target-news history into RatingEvent /
 *    PriceTargetEvent (append-only, deduped by unique constraint).
 */
import { prisma } from "@/infrastructure/db/client";
import {
  fetchGradeEvents,
  fetchGradesConsensus,
  fetchPriceTargetConsensus,
  fetchPriceTargetNews,
  fmpPool,
  type PriceTargetConsensus,
  type RatingDistribution,
} from "@/infrastructure/providers/fmp";

export interface LegBSnapshotPart {
  ticker: string;
  ptConsensus: number | null;
  ptHigh: number | null;
  ptLow: number | null;
  ptMedian: number | null;
  ratingsJson: {
    distribution: RatingDistribution | null;
    priceTarget: PriceTargetConsensus | null;
  };
}

/** Build per-ticker Leg B consensus parts for the universe (per-symbol pool). */
export async function buildLegBConsensus(
  tickers: string[],
  opts: { log?: (msg: string) => void } = {},
): Promise<Map<string, LegBSnapshotPart>> {
  const log = opts.log ?? (() => {});
  const { results, failures } = await fmpPool(
    tickers,
    async (ticker) => {
      const [distribution, priceTarget] = await Promise.all([
        fetchGradesConsensus(ticker),
        fetchPriceTargetConsensus(ticker),
      ]);
      return { ticker, distribution, priceTarget };
    },
    { concurrency: 8 },
  );

  const out = new Map<string, LegBSnapshotPart>();
  for (const { value } of results) {
    const { ticker, distribution, priceTarget } = value;
    if (!distribution && !priceTarget) continue;
    out.set(ticker, {
      ticker,
      ptConsensus: priceTarget?.consensus ?? null,
      ptHigh: priceTarget?.high ?? null,
      ptLow: priceTarget?.low ?? null,
      ptMedian: priceTarget?.median ?? null,
      ratingsJson: { distribution, priceTarget },
    });
  }
  log(`[leg-b] consensus for ${out.size}/${tickers.length} tickers (${failures.length} failed)`);
  return out;
}

export interface LegBBackfillSummary {
  ratingEvents: number;
  priceTargetEvents: number;
  failures: string[];
}

/**
 * Backfill / refresh event-level Leg B history. /grades and /price-target-news
 * return full history per call, so this is idempotent: re-running tails new
 * events (deduped by unique constraint). Heavy (per-symbol) — run on first
 * setup, then periodically rather than every weekly snapshot.
 */
export async function backfillLegBEvents(
  tickers: string[],
  opts: { log?: (msg: string) => void } = {},
): Promise<LegBBackfillSummary> {
  const log = opts.log ?? (() => {});
  let ratingEvents = 0;
  let priceTargetEvents = 0;

  const { failures } = await fmpPool(
    tickers,
    async (ticker) => {
      const [grades, targets] = await Promise.all([
        fetchGradeEvents(ticker),
        fetchPriceTargetNews(ticker),
      ]);
      if (grades.length) {
        const res = await prisma.ratingEvent.createMany({
          data: grades.map((g) => ({
            ticker: g.ticker,
            eventDate: new Date(g.eventDate),
            gradingCompany: g.gradingCompany,
            previousGrade: g.previousGrade,
            newGrade: g.newGrade,
            action: g.action,
          })),
          skipDuplicates: true,
        });
        ratingEvents += res.count;
      }
      if (targets.length) {
        const res = await prisma.priceTargetEvent.createMany({
          data: targets.map((t) => ({
            ticker: t.ticker,
            publishedDate: new Date(t.publishedDate),
            analystCompany: t.analystCompany,
            analystName: t.analystName,
            priceTarget: t.priceTarget ?? undefined,
            priceWhenPosted: t.priceWhenPosted ?? undefined,
            newsPublisher: t.newsPublisher,
          })),
          skipDuplicates: true,
        });
        priceTargetEvents += res.count;
      }
    },
    { concurrency: 8 },
  );

  log(`[leg-b] backfill: +${ratingEvents} rating events, +${priceTargetEvents} PT events`);
  return { ratingEvents, priceTargetEvents, failures: failures.map((f) => `${f.item}: ${f.error}`) };
}
