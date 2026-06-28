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
