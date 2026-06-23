/**
 * Prior-session sparkline sweep runner — long-lived server-side interval that
 * keeps the in-memory prior-session cache current to one sweep per trading day.
 *
 * Singleton + idempotent (safe to call on every boot from instrumentation).
 * Fire-and-forget — swallows errors into runner state for diagnostics.
 *
 * The prior regular session is immutable once closed, so the cache only needs
 * refreshing when the ET calendar date rolls over (a new session has since
 * completed). On boot we populate immediately (the in-memory cache is empty
 * after a restart); thereafter a light interval re-sweeps only on date change.
 */
import { prisma } from "@/infrastructure/db/client";
import { todayEtIsoDate } from "@/lib/factors/attribution/today-et";
import {
  getPriorSessionPopulatedDate,
  sweepPriorSessionSparklines,
} from "./prior-session-sparkline.service";

/** Cadence of the staleness check. The actual Yahoo sweep only fires on a date
 *  change (or after a failed attempt clears its cooldown), so this is cheap. */
const CHECK_INTERVAL_MS = 5 * 60_000;

/** After a sweep that returned zero rows (e.g. total throttle), wait this long
 *  before retrying so a persistent outage doesn't hammer Yahoo. */
const RETRY_COOLDOWN_MS = 10 * 60_000;

let started = false;
let running = false;
let lastSweepAt: string | null = null;
let lastError: string | null = null;
let lastFailedAttemptMs: number | null = null;

export interface PriorSessionRunnerState {
  started: boolean;
  running: boolean;
  lastSweepAt: string | null;
  lastError: string | null;
}

export function getPriorSessionRunnerState(): PriorSessionRunnerState {
  return { started, running, lastSweepAt, lastError };
}

export function startPriorSessionRunner(): void {
  if (started) return;
  started = true;
  console.log(
    `[prior-session] runner started (daily sweep; checks every ${CHECK_INTERVAL_MS / 60_000}m)`,
  );
  void tick();
  setInterval(() => {
    void tick();
  }, CHECK_INTERVAL_MS);
}

async function tick(): Promise<void> {
  if (running) return;

  const todayEt = todayEtIsoDate(new Date());
  if (getPriorSessionPopulatedDate() === todayEt) return;

  if (
    lastFailedAttemptMs != null &&
    Date.now() - lastFailedAttemptMs < RETRY_COOLDOWN_MS
  ) {
    return;
  }

  running = true;
  try {
    const summary = await sweepPriorSessionSparklines(prisma, todayEt);
    if (summary.applied > 0) {
      lastSweepAt = new Date().toISOString();
      lastError = null;
      lastFailedAttemptMs = null;
      console.log(
        `[prior-session] swept ${summary.applied}/${summary.attempted} tickers (${todayEt})`,
      );
    } else {
      lastFailedAttemptMs = Date.now();
      lastError = "sweep returned 0 tickers";
      console.warn(
        `[prior-session] sweep produced 0/${summary.attempted} tickers — will retry after cooldown`,
      );
    }
  } catch (e) {
    lastFailedAttemptMs = Date.now();
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[prior-session] sweep failed:", e);
  } finally {
    running = false;
  }
}
