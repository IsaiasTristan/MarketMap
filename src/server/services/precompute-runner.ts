/**
 * precompute-runner — in-memory background runner + status surface for the
 * daily precompute chain.
 *
 * Why in-memory?
 *   The app is a single-process local Next.js server. Coordinating the
 *   startup catch-up against itself only requires module-level state; we
 *   don't need a DB lock for that. The Windows Scheduled Task runs in a
 *   separate process at 17:00 — that run can overlap a startup run; both
 *   upsert idempotently to PerStockGridSnapshot, last writer wins.
 *
 * Surfaces:
 *   - startPrecompute()         start a run unless one is already running.
 *   - getRunnerState()          snapshot of current state (for the API).
 *   - maybeRunStartupCatchUp()  freshness-guarded fire-and-forget; called
 *                               from src/instrumentation.ts on boot.
 */
import { prisma } from "@/infrastructure/db/client";
import type { DailyPrecomputeSummary } from "./factor-daily-precompute.service";
import { getPrecomputeFreshness } from "@/lib/factors/diagnostics/precompute-freshness";
import { runJobChild } from "./job-spawner";

export type RunnerStatus = "idle" | "running" | "done" | "error";

export interface RunnerState {
  status: RunnerStatus;
  /** When the current/last run was started. */
  startedAt: string | null;
  /** When the last run finished (done | error). */
  finishedAt: string | null;
  /** Error message if `status === "error"`. */
  error: string | null;
  /**
   * Last successful summary. Always null now that the run executes in a
   * separate process (the structured summary is written to the child's log
   * file instead). Kept on the shape for backward compatibility; the UI's
   * "Last saved" badge is driven by DB freshness, not this field.
   */
  lastSummary: DailyPrecomputeSummary | null;
  /** What caused the latest run to start ("startup-catchup" | "manual"). */
  lastTrigger: "startup-catchup" | "manual" | null;
  /** OS process id of the running child precompute, or null when not running. */
  pid: number | null;
}

const state: RunnerState = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  error: null,
  lastSummary: null,
  lastTrigger: null,
  pid: null,
};

export function getRunnerState(): RunnerState {
  return { ...state };
}

/**
 * Start a daily precompute run. No-ops with `started: false` if a run is
 * already in flight.
 *
 * The work runs in a SEPARATE OS process (`npm run job:daily` ->
 * `tsx scripts/daily-precompute.ts`) rather than inline, so the CPU-bound
 * regression chain (~10 min) runs on its own core and never blocks the web
 * server's single-threaded event loop. This is the same entry point the
 * 17:00 Windows Scheduled Task uses, so both run paths share one impl.
 * The spawn goes through the shared job queue (job-spawner) so it serializes
 * with the other heavy background jobs instead of stacking children.
 *
 * Never throws: spawn failures, non-zero exits, and queue skips are recorded
 * in the runner state. The child's stdout/stderr are teed to a timestamped
 * file under `logs/` and mirrored to the server console.
 */
export function startPrecompute(
  trigger: "startup-catchup" | "manual" = "manual",
): { started: boolean; reason?: string } {
  if (state.status === "running") {
    return { started: false, reason: "already-running" };
  }
  state.status = "running";
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.error = null;
  state.lastTrigger = trigger;
  state.lastSummary = null;
  state.pid = null;

  void runJobChild(`precompute-${trigger}`, "job:daily", [], {
    mode: "enqueue",
    onSpawn: (pid) => {
      state.pid = pid;
    },
  }).then((r) => {
    state.finishedAt = new Date().toISOString();
    state.pid = null;
    if (r.ok) {
      state.status = "done";
      console.log("[precompute-runner] child precompute completed.");
    } else {
      state.status = "error";
      state.error = `precompute ${r.error ?? "failed"}`;
      console.error(`[precompute-runner] ${state.error}`);
    }
  });

  return { started: true };
}

/**
 * Server-startup catch-up. Checks the saved-regressions freshness and only
 * fires `startPrecompute` if the cache is stale (no row newer than the last
 * trading close, or any expected row missing). Fire-and-forget; never throws.
 */
export async function maybeRunStartupCatchUp(): Promise<void> {
  try {
    const freshness = await getPrecomputeFreshness(prisma);
    if (!freshness.stale) {
      console.log(
        `[precompute-runner] startup: cache fresh (latest ${freshness.freshestComputedAt}); no catch-up needed.`,
      );
      return;
    }
    // Defer the heavy catch-up so it doesn't contend with interactive
    // navigation right after boot (the child process saturates CPU/DB/Yahoo).
    // Configurable via PRECOMPUTE_STARTUP_DELAY_MS; set to 0 to start
    // immediately.
    const delayMs = Number(process.env.PRECOMPUTE_STARTUP_DELAY_MS ?? 180_000);
    console.log(
      `[precompute-runner] startup: cache stale (freshest=${freshness.freshestComputedAt ?? "none"}, lastClose=${freshness.lastTradingClose}); starting catch-up${delayMs > 0 ? ` in ${Math.round(delayMs / 1000)}s` : ""}.`,
    );
    if (delayMs > 0) {
      setTimeout(() => startPrecompute("startup-catchup"), delayMs);
    } else {
      startPrecompute("startup-catchup");
    }
  } catch (e) {
    console.error("[precompute-runner] startup catch-up check failed:", e);
  }
}
