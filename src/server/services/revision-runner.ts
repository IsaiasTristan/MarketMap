/**
 * Engine 1 (Research) background runner - split cadence.
 *
 * FMP refreshes the two revision data classes at different rates, so this
 * runner mirrors that:
 *   - DAILY:  tail upgrade/downgrade grades + price-target news for the full
 *             active universe (FMP "Stock Grade" updates daily / event-level).
 *             Idempotent dedupe means a tail only writes genuinely new events.
 *   - WEEKLY: snapshot consensus estimates + rating/PT consensus and re-score
 *             (FMP "Analyst Estimates" only revises weekly, so a daily estimate
 *             snapshot would add cost and zero-delta noise). Driven by a
 *             staleness check so it self-heals if the desktop was off when a
 *             week elapsed.
 *
 * Singleton + idempotent (safe to call on every boot from instrumentation).
 * Self-guarded: skips if a prior tick is still in flight. Never throws -
 * failures are swallowed into the runner state. Single-process desktop model,
 * same constraint as the other runners (in-memory gate, not multi-instance).
 */
import { prisma } from "@/infrastructure/db/client";
import { tradeDateEtFromUnix } from "@/lib/market-map/market-session";
import {
  runRevisionDailyEvents,
  type RevisionDailyEventsSummary,
} from "./revision/revision-daily-events.service";
import { runRevisionWeekly } from "./revision/revision-weekly-job.service";
import { scoreRevisionWeek } from "./revision/revision-scoring.service";

/** Hourly tick. Daily/weekly work is gated by ET-date, not by this interval. */
const TICK_INTERVAL_MS = 60 * 60_000;
/** Re-snapshot the weekly consensus once the latest snapshot is this old. */
const WEEKLY_STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

let started = false;
let running = false;
let lastDailyRunDate: string | null = null;
let lastWeeklyRunDate: string | null = null;
let lastDailyAt: string | null = null;
let lastWeeklyAt: string | null = null;
let lastDailySummary: RevisionDailyEventsSummary | null = null;
let lastError: string | null = null;

export interface RevisionRunnerState {
  started: boolean;
  running: boolean;
  lastDailyRunDate: string | null;
  lastWeeklyRunDate: string | null;
  lastDailyAt: string | null;
  lastWeeklyAt: string | null;
  lastDailySummary: RevisionDailyEventsSummary | null;
  lastError: string | null;
}

export function getRevisionRunnerState(): RevisionRunnerState {
  return {
    started,
    running,
    lastDailyRunDate,
    lastWeeklyRunDate,
    lastDailyAt,
    lastWeeklyAt,
    lastDailySummary,
    lastError,
  };
}

/** Today's calendar date (yyyy-MM-dd) in US Eastern. */
function etToday(): string {
  return tradeDateEtFromUnix(Math.floor(Date.now() / 1000));
}

/** Pure: daily event tail is due when it has not yet run for today's ET date. */
export function isDailyDue(lastRunDate: string | null, today: string): boolean {
  return lastRunDate !== today;
}

/** Pure: weekly snapshot is stale with no snapshot yet or the latest >= N days old. */
export function isWeeklyStale(
  latestSnapshotMs: number | null,
  nowMs: number,
  staleDays = WEEKLY_STALE_DAYS,
): boolean {
  if (latestSnapshotMs == null) return true;
  return (nowMs - latestSnapshotMs) / DAY_MS >= staleDays;
}

/** True when no weekly consensus snapshot exists or the latest is >= 7d old. */
async function weeklySnapshotIsStale(): Promise<boolean> {
  const latest = await prisma.revisionSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  return isWeeklyStale(latest?.snapshotDate.getTime() ?? null, Date.now());
}

/**
 * Start the singleton runner. Idempotent - repeated calls are no-ops.
 * Fires once on boot (catch-up), then hourly.
 */
export function startRevisionRunner(): void {
  if (started) return;
  started = true;
  console.log(
    `[revision-runner] started (daily events + weekly snapshot catch-up; tick every ${TICK_INTERVAL_MS / 60_000}m)`,
  );
  void tick();
  setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  const today = etToday();
  try {
    // Daily: tail rating / price-target events once per ET calendar day.
    if (isDailyDue(lastDailyRunDate, today)) {
      const summary = await runRevisionDailyEvents({
        log: (m) => console.log(m),
      });
      lastDailyRunDate = today;
      lastDailyAt = new Date().toISOString();
      lastDailySummary = summary;
      console.log(
        `[revision-runner] daily events: +${summary.ratingEvents} ratings, +${summary.priceTargetEvents} PTs over ${summary.universeSize} tickers (${summary.failures} failed)`,
      );
    }

    // Weekly: re-snapshot + re-score when the consensus snapshot is stale.
    // Attempted at most once per ET day so a transient FMP outage cannot
    // hammer the endpoint hourly.
    if (lastWeeklyRunDate !== today && (await weeklySnapshotIsStale())) {
      const ingest = await runRevisionWeekly({ log: (m) => console.log(m) });
      if (ingest.snapshotsWritten > 0) {
        await scoreRevisionWeek({ snapshotDate: ingest.snapshotDate, log: (m) => console.log(m) });
      }
      lastWeeklyRunDate = today;
      lastWeeklyAt = new Date().toISOString();
      console.log(
        `[revision-runner] weekly snapshot: ${ingest.snapshotsWritten} written (${ingest.universeSize} tickers)`,
      );
    } else if (lastWeeklyRunDate !== today) {
      // Not stale yet; record that we checked today so we don't re-query hourly.
      lastWeeklyRunDate = today;
    }

    lastError = null;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[revision-runner] tick failed:", e);
  } finally {
    running = false;
  }
}
