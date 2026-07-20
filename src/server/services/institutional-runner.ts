/**
 * Engine 3 (13F institutional) background runner - settle-date cadence.
 *
 * 13F is quarterly at the source (filings settle ~45 days after quarter-end),
 * then late filers and amendments trickle in for weeks. The runner mirrors that:
 *   - GATE A (new settled quarter): when `latestSettledQuarter(now)` is newer
 *     than the newest ingested FundBookSnapshot.filingPeriod, ingest + aggregate
 *     immediately - new quarters land within a day of settling (~Feb/May/Aug/
 *     Nov 16) instead of whenever someone remembers to run the CLI. Depth
 *     scales to how many settled quarters the store is behind (capped at 12).
 *   - GATE B (late-filer/amendment refresh): within LATE_FILER_WINDOW_DAYS of
 *     the settle date, re-ingest the latest 2 quarters weekly. Ingestion is
 *     idempotent (delete+rewrite per fund/period), so re-runs are safe.
 *
 * Gate A reads the DB, so it is durable across restarts; Gate B's spacing uses
 * max(FundBookSnapshot.createdAt) - the slice rewrite timestamp - so reboots
 * don't trigger spurious refreshes. Concurrent admin-route ingests are
 * tolerated the same way as elsewhere: last-writer-wins per-(fund, period).
 *
 * Singleton + idempotent (safe to call on every boot from instrumentation).
 * Self-guarded, never throws, single-process desktop model - same constraints
 * as the other runners. Skips entirely while the fund watchlist is unseeded.
 */
import { prisma } from "@/infrastructure/db/client";
import { tradeDateEtFromUnix } from "@/lib/market-map/market-session";
import {
  latestSettledQuarter,
  quarterEnd,
} from "./institutional/institutional-ingest.service";
import { runJobChild } from "./job-spawner";

/** Hourly tick. Work is gated by ET-date + DB state, not the interval. */
const TICK_INTERVAL_MS = 60 * 60_000;
/** Light-refresh depth (latest quarter + prior for the diff pass). */
const LIGHT_REFRESH_QUARTERS = 2;
/** Full standard depth when the store is empty / far behind (CLI default). */
const MAX_REFRESH_QUARTERS = 12;
/** 13F settlement window used by latestSettledQuarter (period-end + 46d). */
const SETTLE_DAYS = 46;
/** Re-run for late filers/amendments up to this long after the settle date. */
const LATE_FILER_WINDOW_DAYS = 60;
/** Minimum spacing between late-filer refreshes. */
const LATE_FILER_REFRESH_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

let started = false;
let running = false;
let lastCheckDate: string | null = null;
let lastRunAt: string | null = null;
let lastRunReason: "new-quarter" | "late-filer" | null = null;
let lastError: string | null = null;

export interface InstitutionalRunnerState {
  started: boolean;
  running: boolean;
  lastCheckDate: string | null;
  lastRunAt: string | null;
  lastRunReason: "new-quarter" | "late-filer" | null;
  lastError: string | null;
}

export function getInstitutionalRunnerState(): InstitutionalRunnerState {
  return { started, running, lastCheckDate, lastRunAt, lastRunReason, lastError };
}

/** Today's calendar date (yyyy-MM-dd) in US Eastern. */
function etToday(): string {
  return tradeDateEtFromUnix(Math.floor(Date.now() / 1000));
}

/**
 * Pure: how many settled quarters the store is behind (0 = current).
 * `null` latestIngestedPeriodEnd (empty store) means fully behind.
 */
export function quartersBehind(latestIngestedPeriodEnd: string | null, now: Date): number {
  const settled = latestSettledQuarter(now);
  if (latestIngestedPeriodEnd === null) return MAX_REFRESH_QUARTERS;
  let { year, quarter } = settled;
  let behind = 0;
  while (behind < MAX_REFRESH_QUARTERS) {
    if (quarterEnd(year, quarter) <= latestIngestedPeriodEnd) break;
    behind++;
    quarter -= 1;
    if (quarter === 0) {
      quarter = 4;
      year -= 1;
    }
  }
  return behind;
}

/** Pure: a settled quarter exists that the store has not ingested yet. */
export function isNewSettledQuarter(latestIngestedPeriodEnd: string | null, now: Date): boolean {
  return quartersBehind(latestIngestedPeriodEnd, now) > 0;
}

/**
 * Pure: a weekly late-filer/amendment refresh is due - we are within the
 * post-settle window and the last slice rewrite is >= LATE_FILER_REFRESH_DAYS old.
 */
export function isLateFilerRefreshDue(now: Date, lastIngestMs: number | null): boolean {
  const settled = latestSettledQuarter(now);
  const settleMs = new Date(`${settled.periodEnd}T00:00:00Z`).getTime() + SETTLE_DAYS * DAY_MS;
  const daysSinceSettle = (now.getTime() - settleMs) / DAY_MS;
  if (daysSinceSettle < 0 || daysSinceSettle > LATE_FILER_WINDOW_DAYS) return false;
  if (lastIngestMs === null) return true;
  return (now.getTime() - lastIngestMs) / DAY_MS >= LATE_FILER_REFRESH_DAYS;
}

/**
 * Start the singleton runner. Idempotent - repeated calls are no-ops.
 * Fires once on boot (catch-up), then hourly.
 */
export function startInstitutionalRunner(): void {
  if (started) return;
  started = true;
  console.log(
    `[institutional-runner] started (settle-triggered ingest + weekly late-filer refresh; tick every ${TICK_INTERVAL_MS / 60_000}m)`,
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
    // Gates are checked at most once per ET day so a transient FMP outage
    // cannot hammer the endpoints hourly.
    if (lastCheckDate === today) return;
    lastCheckDate = today;

    const activeFunds = await prisma.institutionalFund.count({ where: { isActive: true } });
    if (activeFunds === 0) return; // watchlist unseeded - nothing to ingest

    const now = new Date();
    const [latestPeriodRow, lastWriteRow] = await Promise.all([
      prisma.fundBookSnapshot.aggregate({ _max: { filingPeriod: true } }),
      prisma.fundBookSnapshot.aggregate({ _max: { createdAt: true } }),
    ]);
    const latestPeriodEnd =
      latestPeriodRow._max.filingPeriod?.toISOString().slice(0, 10) ?? null;
    const lastIngestMs = lastWriteRow._max.createdAt?.getTime() ?? null;

    let reason: "new-quarter" | "late-filer" | null = null;
    let quarters = LIGHT_REFRESH_QUARTERS;
    if (isNewSettledQuarter(latestPeriodEnd, now)) {
      reason = "new-quarter";
      // +1 so the diff pass has the prior quarter as its baseline.
      quarters = Math.min(MAX_REFRESH_QUARTERS, quartersBehind(latestPeriodEnd, now) + 1);
    } else if (isLateFilerRefreshDue(now, lastIngestMs)) {
      reason = "late-filer";
    }
    if (!reason) return;

    console.log(
      `[institutional-runner] ${reason}: ingesting ${quarters}q (store at ${latestPeriodEnd ?? "empty"})`,
    );
    // Child process: job:institutional runs ingest + aggregate by default,
    // matching the old in-process path. 13F bursts are the heaviest ingest in
    // the app; the child returns its memory to the OS on exit.
    const r = await runJobChild(
      "institutional",
      "job:institutional",
      [`--quarters=${quarters}`],
      { mode: "enqueue" },
    );
    if (r.ok) {
      lastRunAt = new Date().toISOString();
      lastRunReason = reason;
      lastError = null;
      console.log(`[institutional-runner] ${reason} child completed.`);
    } else if (!r.skipped) {
      lastError = r.error;
      console.error(`[institutional-runner] ${reason} child failed: ${r.error}`);
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[institutional-runner] tick failed:", e);
  } finally {
    running = false;
  }
}
