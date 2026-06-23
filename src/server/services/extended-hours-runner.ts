/**
 * Extended-hours sweep runner — long-lived server-side interval that
 * refreshes the extended-hours snapshot during PRE and POST sessions.
 *
 * Singleton: `startExtendedHoursRunner()` is idempotent; calling it more
 * than once is a no-op so `instrumentation.ts` can call it on every server
 * boot without risk.
 *
 * Self-guarded: each tick respects the current market session and skips if
 * a prior sweep is still in flight. When the session transitions out of
 * an extended window (to REGULAR or CLOSED), the snapshot is cleared so the
 * API does not silently serve stale pre-market data to viewers during the
 * regular session.
 *
 * No browser dependency: this is the whole point. The 24/7 desktop hosts
 * the server process, but the admin's browser is not always open. Server-
 * side scheduling is the only way to keep the overlay reliable for all
 * 10 viewers regardless of who is looking.
 */
import { prisma } from "@/infrastructure/db/client";
import { getUsMarketSession } from "@/lib/market-map/market-session";
import {
  clearExtendedSnapshot,
  getExtendedSnapshot,
  sweepExtendedHours,
} from "./extended-hours.service";

/**
 * Interval between sweeps. Mirrors the existing regular-hours tail-ingest
 * cadence (60s) so the network footprint is comparable. Each sweep issues
 * one Yahoo HTTP call per active ticker, throttled by the 5-worker pool
 * inside `fetchYahooExtendedQuotes` (~150ms politeness gap per worker).
 */
const SWEEP_INTERVAL_MS = 60_000;

/** When in CLOSED with an empty snapshot, only attempt a backfill at most
 *  this often. Prevents a persistent Yahoo outage from hammering the
 *  endpoint every 60s overnight / over a weekend. A single backfill is
 *  ~one Yahoo call per active ticker; the cooldown keeps the total volume
 *  bounded to one full sweep per 5 min in the failure case. */
const BACKFILL_COOLDOWN_MS = 5 * 60_000;

let started = false;
let running = false;
let lastSweepAt: string | null = null;
let lastError: string | null = null;
/** Epoch ms of the most recent backfill attempt (success or failure). Used
 *  to gate the CLOSED-startup retry loop with `BACKFILL_COOLDOWN_MS`. */
let lastBackfillAttemptMs: number | null = null;

export interface ExtendedRunnerState {
  started: boolean;
  running: boolean;
  lastSweepAt: string | null;
  lastError: string | null;
}

export function getExtendedRunnerState(): ExtendedRunnerState {
  return { started, running, lastSweepAt, lastError };
}

/**
 * Start the singleton sweep loop. Idempotent — repeated calls are no-ops.
 * Fire-and-forget: never throws, swallows any sweep error into the runner
 * state for diagnostics.
 */
export function startExtendedHoursRunner(): void {
  if (started) return;
  started = true;
  console.log(
    `[extended-hours] runner started (sweep every ${SWEEP_INTERVAL_MS / 1000}s during PRE/POST)`,
  );
  // Fire once immediately on boot so the snapshot is populated without
  // waiting a full interval — important when the server restarts mid-
  // session.
  void tick();
  setInterval(() => {
    void tick();
  }, SWEEP_INTERVAL_MS);
}

async function tick(): Promise<void> {
  if (running) return;
  const session = getUsMarketSession(new Date());

  // REGULAR: live regular-session prices supersede any extended-hours
  // overlay; clear the snapshot so the API never serves yesterday's
  // post-market data while today's regular session is running.
  if (session === "REGULAR") {
    clearExtendedSnapshot();
    return;
  }

  // CLOSED: never clear the snapshot — users explicitly want to look at
  // the most recent extended-hours move overnight (after 20:00 ET until
  // the next 04:00 ET) and over weekends. If a recent PRE/POST sweep is
  // still in memory we just leave it there; the next PRE/POST sweep will
  // replace it wholesale, so tomorrow's PRE never displays yesterday's
  // data.
  //
  // When the snapshot is empty (server restart during CLOSED, or a fresh
  // boot first thing on a weekend morning), fire a one-shot BACKFILL
  // sweep using a 5-day Yahoo range so we can recover the most recent
  // POST print regardless of how long ago it happened. Cooldown gates
  // this so a persistent Yahoo outage doesn't loop every 60s.
  if (session === "CLOSED") {
    const snap = getExtendedSnapshot();
    if (snap.quotes.size > 0) return;

    const now = Date.now();
    if (
      lastBackfillAttemptMs != null &&
      now - lastBackfillAttemptMs < BACKFILL_COOLDOWN_MS
    ) {
      return;
    }
    lastBackfillAttemptMs = now;

    running = true;
    try {
      const summary = await sweepExtendedHours(prisma, "BACKFILL");
      lastSweepAt = new Date().toISOString();
      lastError = null;
      console.log(
        `[extended-hours] backfilled ${summary.applied}/${summary.attempted} tickers (CLOSED startup)`,
      );
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.error("[extended-hours] backfill failed:", e);
    } finally {
      running = false;
    }
    return;
  }

  // PRE / POST: refresh the snapshot with the latest extended-hours prints.
  running = true;
  try {
    const summary = await sweepExtendedHours(prisma, session);
    lastSweepAt = new Date().toISOString();
    lastError = null;
    console.log(
      `[extended-hours] swept ${summary.applied}/${summary.attempted} tickers (${session})`,
    );
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[extended-hours] sweep failed:", e);
  } finally {
    running = false;
  }
}
