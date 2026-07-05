/**
 * Engine 1 — weekly ingestion orchestrator. Single code path shared by the CLI
 * (scripts/revision-weekly.ts) and any startup catch-up. Assembles one
 * append-only RevisionSnapshot row per (ticker, snapshotDate) by merging Leg A
 * (per-symbol estimates) and Leg B (bulk consensus), plus the next earnings
 * date. Idempotent upserts; per-step failures are captured, not thrown.
 *
 * Event-level Leg B history (RatingEvent / PriceTargetEvent) is a separate,
 * heavier concern toggled by `backfillEvents` (first run / periodic), not part
 * of every weekly snapshot.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import { buildLegASnapshots } from "./leg-a-ingest.service";
import { buildLegBConsensus, backfillLegBEvents } from "./leg-b-ingest.service";
import { loadNextEarnings } from "./earnings-calendar.service";
import {
  buildReferenceFromMarketMap,
  loadActiveUniverseTickers,
  refreshRevisionReference,
} from "./reference-ingest.service";
import { capturePriceWeek } from "./price-ingest.service";
import { appendLegBWeek } from "./legb-weekly.service";
import { scoreRevisionWeek, type ScoreSummary } from "./revision-scoring.service";
import { computeAndCacheValidation } from "./revision-validation.service";

/** Where the revision universe (the list of tickers) comes from. */
export type ReferenceSource = "MARKET_MAP" | "FMP_SCREENER";

export interface RevisionWeeklyOptions {
  snapshotDate?: string; // YYYY-MM-DD; defaults to today (UTC)
  refreshReference?: boolean; // rebuild the universe first (default true)
  /** MARKET_MAP (default): the user's saved universe; FMP_SCREENER: cap-ranked screener. */
  referenceSource?: ReferenceSource;
  /** Specific market-map universe to source from (MARKET_MAP only). */
  universeId?: string;
  backfillEvents?: boolean; // also (re)load Leg B event history (default false)
  enrichProfiles?: boolean; // CIK enrichment during reference refresh (FMP_SCREENER only)
  maxUniverse?: number; // cap the universe size (FMP_SCREENER smoke tests / staged rollout)
  log?: (msg: string) => void;
}

export interface RevisionWeeklySummary {
  snapshotDate: string;
  universeSize: number;
  snapshotsWritten: number;
  legAFailures: number;
  events?: { ratingEvents: number; priceTargetEvents: number; failures: number };
  failures: string[];
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runRevisionWeekly(
  opts: RevisionWeeklyOptions = {},
): Promise<RevisionWeeklySummary> {
  const log = opts.log ?? (() => {});
  const snapshotDate = opts.snapshotDate ?? todayIso();
  const failures: string[] = [];

  // Step 1 — universe. Default to the user's saved market-map universe; the
  // FMP screener remains available for the legacy cap-ranked behavior.
  const referenceSource: ReferenceSource = opts.referenceSource ?? "MARKET_MAP";
  if (opts.refreshReference !== false) {
    const ref =
      referenceSource === "FMP_SCREENER"
        ? await refreshRevisionReference({
            enrichProfiles: opts.enrichProfiles,
            maxUniverse: opts.maxUniverse,
            log,
          })
        : await buildReferenceFromMarketMap({ universeId: opts.universeId, log });
    failures.push(...ref.failures.slice(0, 20));
  }
  const tickers = await loadActiveUniverseTickers();
  log(`[weekly] universe: ${tickers.length} active tickers; snapshotDate=${snapshotDate}`);
  if (tickers.length === 0) {
    return { snapshotDate, universeSize: 0, snapshotsWritten: 0, legAFailures: 0, failures };
  }

  // Step 2 — proximity inputs.
  const nextEarnings = await loadNextEarnings(tickers, snapshotDate).catch((e) => {
    failures.push(`earnings-calendar: ${e instanceof Error ? e.message : String(e)}`);
    return new Map<string, string>();
  });

  // Step 3 — Leg B consensus (bulk) + Leg A estimates (per-symbol).
  const legB = await buildLegBConsensus(tickers, { log }).catch((e) => {
    failures.push(`leg-b consensus: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  });
  const { parts: legA, failures: legAFailures } = await buildLegASnapshots(
    tickers,
    snapshotDate,
    { log },
  );

  // Step 4 — merge + upsert one snapshot per ticker.
  const snapDate = new Date(`${snapshotDate}T00:00:00Z`);
  let written = 0;
  for (const ticker of tickers) {
    const a = legA.get(ticker);
    const b = legB.get(ticker);
    if (!a && !b) continue;
    const earnings = nextEarnings.get(ticker);
    try {
      const data = {
        revenueAvg: a?.revenueAvg ?? null,
        epsAvg: a?.epsAvg ?? null,
        numAnalystsRevenue: a?.numAnalystsRevenue ?? null,
        numAnalystsEps: a?.numAnalystsEps ?? null,
        ptConsensus: b?.ptConsensus ?? null,
        ptHigh: b?.ptHigh ?? null,
        ptLow: b?.ptLow ?? null,
        ptMedian: b?.ptMedian ?? null,
        nextEarningsDate: earnings ? new Date(`${earnings}T00:00:00Z`) : null,
        estimatesJson: (a?.estimatesJson ?? undefined) as Prisma.InputJsonValue | undefined,
        ratingsJson: (b?.ratingsJson ?? undefined) as Prisma.InputJsonValue | undefined,
      };
      await prisma.revisionSnapshot.upsert({
        where: { ticker_snapshotDate: { ticker, snapshotDate: snapDate } },
        create: { ticker, snapshotDate: snapDate, source: "FMP", ...data },
        update: data,
      });
      written++;
    } catch (e) {
      failures.push(`snapshot ${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log(`[weekly] wrote ${written} snapshots`);

  // Step 5 — optional event backfill/refresh.
  let events: RevisionWeeklySummary["events"];
  if (opts.backfillEvents) {
    const b = await backfillLegBEvents(tickers, { log });
    events = {
      ratingEvents: b.ratingEvents,
      priceTargetEvents: b.priceTargetEvents,
      failures: b.failures.length,
    };
    failures.push(...b.failures.slice(0, 20));
  }

  return {
    snapshotDate,
    universeSize: tickers.length,
    snapshotsWritten: written,
    legAFailures: legAFailures.length,
    events,
    failures,
  };
}

export interface RevisionPipelineOptions extends RevisionWeeklyOptions {
  /** Weekly price capture (default true; scoring degrades to null px z if it fails). */
  capturePrices?: boolean;
  /** Append the Leg-B point-in-time week (default true). */
  appendLegB?: boolean;
  /** Recompute + cache the validation payload at the end (default true). */
  revalidate?: boolean;
}

export interface RevisionPipelineSummary {
  ingest: RevisionWeeklySummary;
  priceCapture: { rowsWritten: number; coverage: number; failures: number } | null;
  legBAppend: { rowsWritten: number } | null;
  scoring: ScoreSummary | null;
  validation: { effectiveWeeks: { full: number; legB: number; price: number } } | null;
  stepErrors: string[];
}

/**
 * The full weekly pipeline — ingest, price capture, Leg-B append, scoring
 * (+ transitions), validation cache — in dependency order. One code path for
 * the runner, the CLI, and the ingest route. Each step is try/caught so a
 * partial failure degrades (e.g. missing prices -> null px z / gap) instead of
 * aborting the week.
 */
export async function runRevisionPipeline(
  opts: RevisionPipelineOptions = {},
): Promise<RevisionPipelineSummary> {
  const log = opts.log ?? (() => {});
  const stepErrors: string[] = [];

  const ingest = await runRevisionWeekly(opts);
  const summary: RevisionPipelineSummary = {
    ingest,
    priceCapture: null,
    legBAppend: null,
    scoring: null,
    validation: null,
    stepErrors,
  };
  if (ingest.snapshotsWritten === 0) {
    log("[pipeline] no snapshots written; skipping downstream steps");
    return summary;
  }

  if (opts.capturePrices !== false) {
    try {
      const p = await capturePriceWeek({ snapshotDate: ingest.snapshotDate, log });
      summary.priceCapture = { rowsWritten: p.rowsWritten, coverage: p.coverage, failures: p.failures.length };
    } catch (e) {
      stepErrors.push(`price-capture: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (opts.appendLegB !== false) {
    try {
      const b = await appendLegBWeek({ snapshotDate: ingest.snapshotDate, log });
      summary.legBAppend = { rowsWritten: b.rowsWritten };
    } catch (e) {
      stepErrors.push(`legb-append: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    summary.scoring = await scoreRevisionWeek({ snapshotDate: ingest.snapshotDate, log });
  } catch (e) {
    stepErrors.push(`scoring: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (opts.revalidate !== false && summary.scoring) {
    try {
      const v = await computeAndCacheValidation({ log });
      summary.validation = { effectiveWeeks: v.effectiveWeeks };
    } catch (e) {
      stepErrors.push(`validation: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (stepErrors.length) log(`[pipeline] completed with step errors: ${stepErrors.join(" | ")}`);
  return summary;
}
