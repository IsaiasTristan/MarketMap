/**
 * Engine 2 (Fundamentals) background runner - split cadence.
 *
 * Fundamentals only change on filings, so the cadence mirrors the source:
 *   - DAILY:  one bulk FMP earnings-calendar call finds which universe tickers
 *             reported since the last covered date; only those get their
 *             statements re-fetched. The refreshed snapshots PATCH the latest
 *             existing snapshotDate (upsert on (ticker, snapshotDate)) - never
 *             a new sparse date - because scoring loads the cohort at the
 *             single latest snapshotDate and a partial date would collapse the
 *             discovery queue to that day's reporters.
 *   - WEEKLY: full-universe sweep + re-score when the latest snapshot is >= 7
 *             days old (backstop for restatements and anything the daily path
 *             missed). Staleness-gated so it self-heals if the desktop was off
 *             when a week elapsed. First-time backfill stays a manual step
 *             (`npm run job:fundamental -- --backfill`).
 *
 * Singleton + idempotent (safe to call on every boot from instrumentation).
 * Self-guarded: skips if a prior tick is still in flight. Never throws -
 * failures are swallowed into the runner state. Single-process desktop model,
 * same constraint as the other runners (in-memory gate, not multi-instance).
 */
import { prisma } from "@/infrastructure/db/client";
import type { EarningsCalendarEntry } from "@/infrastructure/providers/fmp";
import { tradeDateEtFromUnix } from "@/lib/market-map/market-session";
import { isDailyDue, isWeeklyStale } from "./revision-runner";
import { runJobChild } from "./job-spawner";

/** Hourly tick. Daily/weekly work is gated by ET-date/staleness, not the interval. */
const TICK_INTERVAL_MS = 60 * 60_000;
/** Re-sweep the full universe once the latest snapshot is this old. */
const WEEKLY_STALE_DAYS = 7;
/** Calendar lookback when no covered date is known (fresh boot). Longer gaps
 *  (PC off > 3 days) are healed by the weekly sweep, so this stays short. */
const DAILY_LOOKBACK_DAYS = 3;

let started = false;
let running = false;
let lastDailyRunDate: string | null = null;
let lastWeeklyRunDate: string | null = null;
/** Last calendar date the daily path covered (inclusive re-fetch on the next
 *  run so AMC reporters whose statements were not yet posted get picked up). */
let lastCoveredDate: string | null = null;
let lastDailyAt: string | null = null;
let lastWeeklyAt: string | null = null;
let lastDailySummary: { reported: number; snapshotsWritten: number } | null = null;
let lastError: string | null = null;

export interface FundamentalRunnerState {
  started: boolean;
  running: boolean;
  lastDailyRunDate: string | null;
  lastWeeklyRunDate: string | null;
  lastCoveredDate: string | null;
  lastDailyAt: string | null;
  lastWeeklyAt: string | null;
  lastDailySummary: { reported: number; snapshotsWritten: number } | null;
  lastError: string | null;
}

export function getFundamentalRunnerState(): FundamentalRunnerState {
  return {
    started,
    running,
    lastDailyRunDate,
    lastWeeklyRunDate,
    lastCoveredDate,
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

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Pure: unique universe tickers with a calendar entry on/after `sinceIso`.
 * The calendar is global, so intersect with the active universe here.
 */
export function selectReportedTickers(
  entries: Pick<EarningsCalendarEntry, "ticker" | "date">[],
  universeTickers: string[],
  sinceIso: string,
): string[] {
  const universe = new Set(universeTickers.map((t) => t.toUpperCase()));
  const out = new Set<string>();
  for (const e of entries) {
    const t = e.ticker.toUpperCase();
    if (e.date >= sinceIso && universe.has(t)) out.add(t);
  }
  return [...out];
}

/** Latest stored snapshot date, or null when the store is empty (pre-backfill). */
async function latestSnapshotDate(): Promise<Date | null> {
  const latest = await prisma.fundamentalSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  return latest?.snapshotDate ?? null;
}

/**
 * Start the singleton runner. Idempotent - repeated calls are no-ops.
 * Fires once on boot (catch-up), then hourly.
 */
export function startFundamentalRunner(): void {
  if (started) return;
  started = true;
  console.log(
    `[fundamental-runner] started (daily earnings-driven incremental + weekly sweep catch-up; tick every ${TICK_INTERVAL_MS / 60_000}m)`,
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
  const errors: string[] = [];
  try {
    // Weekly: full-universe sweep + re-score when the snapshot store is stale.
    // Attempted at most once per ET day so a transient FMP outage cannot
    // hammer the endpoint hourly. A completed sweep also covers today's daily
    // path (the sweep re-fetches every ticker), so mark both.
    if (lastWeeklyRunDate !== today) {
      const latest = await latestSnapshotDate();
      if (isWeeklyStale(latest?.getTime() ?? null, Date.now(), WEEKLY_STALE_DAYS)) {
        // Child process: job:fundamental with no flags runs the same sweep +
        // scoring the old in-process path did. Gates advance only on a clean
        // exit so a failed sweep retries on the next hourly tick.
        const r = await runJobChild("fundamental-weekly", "job:fundamental", [], {
          mode: "enqueue",
        });
        if (r.ok) {
          lastWeeklyAt = new Date().toISOString();
          lastWeeklyRunDate = today;
          lastDailyRunDate = today; // the sweep re-fetches every ticker
          lastCoveredDate = today;
          console.log("[fundamental-runner] weekly sweep child completed.");
        } else if (!r.skipped) {
          errors.push(`weekly: ${r.error}`);
          console.error(`[fundamental-runner] weekly sweep child failed: ${r.error}`);
        }
      } else {
        lastWeeklyRunDate = today; // checked today; don't re-query hourly
      }
    }

    // Daily: earnings-driven incremental once per ET calendar day, in a child
    // process (scripts/fundamental-daily.ts patches the latest EXISTING
    // snapshot date so the scored cohort stays full-universe). Only --since is
    // passed on the command line; the child derives the ticker list itself.
    if (isDailyDue(lastDailyRunDate, today)) {
      const latest = await latestSnapshotDate();
      if (latest === null) {
        // No baseline yet - the weekly path (or the manual backfill) owns it.
        lastDailyRunDate = today;
      } else {
        const since = lastCoveredDate ?? addDaysIso(today, -DAILY_LOOKBACK_DAYS);
        const r = await runJobChild(
          "fundamental-daily",
          "job:fundamental-daily",
          [`--since=${since}`],
          { mode: "enqueue" },
        );
        if (r.ok) {
          lastDailyRunDate = today;
          lastCoveredDate = today;
          lastDailyAt = new Date().toISOString();
          lastDailySummary = null; // structured summary lives in the child's log
          console.log(
            `[fundamental-runner] daily incremental child completed (since ${since}).`,
          );
        } else if (!r.skipped) {
          errors.push(`daily: ${r.error}`);
          console.error(`[fundamental-runner] daily incremental child failed: ${r.error}`);
        }
      }
    }

    lastError = errors.length > 0 ? errors.join("; ") : null;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[fundamental-runner] tick failed:", e);
  } finally {
    running = false;
  }
}
