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
import { fetchEarningsCalendar, type EarningsCalendarEntry } from "@/infrastructure/providers/fmp";
import { tradeDateEtFromUnix } from "@/lib/market-map/market-session";
import { isDailyDue, isWeeklyStale } from "./revision-runner";
import { runFundamentalWeekly } from "./fundamental/fundamental-weekly-job.service";
import { scoreFundamentalBoxesWeek } from "./fundamental/fundamental-box-scoring.service";
import { loadActiveUniverseTickers } from "./revision/reference-ingest.service";

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
  try {
    // Weekly: full-universe sweep + re-score when the snapshot store is stale.
    // Attempted at most once per ET day so a transient FMP outage cannot
    // hammer the endpoint hourly. A completed sweep also covers today's daily
    // path (the sweep re-fetches every ticker), so mark both.
    if (lastWeeklyRunDate !== today) {
      const latest = await latestSnapshotDate();
      if (isWeeklyStale(latest?.getTime() ?? null, Date.now(), WEEKLY_STALE_DAYS)) {
        const ingest = await runFundamentalWeekly({ log: (m) => console.log(m) });
        if (ingest.snapshotsWritten > 0) {
          await scoreFundamentalBoxesWeek({ snapshotDate: ingest.snapshotDate, log: (m) => console.log(m) });
        }
        lastWeeklyAt = new Date().toISOString();
        lastDailyRunDate = today;
        lastCoveredDate = today;
        console.log(
          `[fundamental-runner] weekly sweep: ${ingest.snapshotsWritten} snapshots (${ingest.universeSize} tickers, ${ingest.failures.length} failures)`,
        );
      }
      lastWeeklyRunDate = today; // checked (or ran) today; don't re-query hourly
    }

    // Daily: earnings-driven incremental once per ET calendar day. Patches the
    // latest EXISTING snapshot date so the scored cohort stays full-universe.
    if (isDailyDue(lastDailyRunDate, today)) {
      const latest = await latestSnapshotDate();
      if (latest === null) {
        // No baseline yet - the weekly path (or the manual backfill) owns it.
        lastDailyRunDate = today;
      } else {
        const since = lastCoveredDate ?? addDaysIso(today, -DAILY_LOOKBACK_DAYS);
        const [entries, universe] = await Promise.all([
          fetchEarningsCalendar(since, today),
          loadActiveUniverseTickers(),
        ]);
        const reported = selectReportedTickers(entries, universe, since);
        let snapshotsWritten = 0;
        if (reported.length > 0) {
          const snapshotDate = latest.toISOString().slice(0, 10);
          const ingest = await runFundamentalWeekly({
            tickers: reported,
            snapshotDate,
            log: (m) => console.log(m),
          });
          snapshotsWritten = ingest.snapshotsWritten;
          if (ingest.snapshotsWritten > 0) {
            await scoreFundamentalBoxesWeek({ snapshotDate, log: (m) => console.log(m) });
          }
        }
        lastDailyRunDate = today;
        lastCoveredDate = today;
        lastDailyAt = new Date().toISOString();
        lastDailySummary = { reported: reported.length, snapshotsWritten };
        console.log(
          `[fundamental-runner] daily incremental: ${reported.length} reported since ${since}, ${snapshotsWritten} snapshots patched`,
        );
      }
    }

    lastError = null;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[fundamental-runner] tick failed:", e);
  } finally {
    running = false;
  }
}
