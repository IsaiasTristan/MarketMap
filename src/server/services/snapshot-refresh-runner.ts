/**
 * Snapshot-refresh runner — long-lived server-side interval that keeps the
 * "hot" precomputed snapshots warm during the REGULAR US session so warm GET
 * reads stay sub-second and at most ~one interval stale.
 *
 * Singleton: `startSnapshotRefreshRunner()` is idempotent; calling it more than
 * once is a no-op so `instrumentation.ts` can call it on every boot.
 *
 * Self-guarded: each tick acts only during REGULAR (off-hours daily data is
 * static — the daily job + cold-miss write-through cover everything else) and
 * skips if a prior refresh is still in flight.
 *
 * The refresh itself runs in a CHILD process (`npm run job:snapshot-hotset` →
 * scripts/snapshot-refresh-hotset.ts → `refreshHotSet` below), not in the web
 * server: the per-portfolio factor-engine runs (rolling OLS over 252d) were
 * the largest steady allocation source in the web process and pinned it at
 * its heap ceiling. All outputs are DB-backed snapshots with route cold-miss
 * write-through, so serving is unaffected by where the refresh runs. The
 * cadence is 5 minutes (was 60s in-process) — exposure/attribution over a
 * 252-day window barely move minute-to-minute, and the latency-sensitive
 * market-map grid is owned by regular-runner, which stays in-process.
 *
 * Hot set (bounded to avoid re-creating a compute storm on the shared host):
 *   - factor-performance RETURN × SP500,
 *   - exposure + attribution for every portfolio at the default MACRO14 / 252
 *     (one engine run feeds both).
 * Every other (model, window) combo stays warmed by the daily job and
 * self-heals via the routes' cold-miss write-through.
 *
 * NOTE: the market-map cache is intentionally NOT refreshed here during
 * REGULAR — the regular-hours runner (`regular-runner.ts`) owns it so it can
 * bake today's live intraday overlay into the same cache row. Refreshing it
 * here from static PriceHistory would clobber that overlay with yesterday's
 * close-to-close data.
 */
import { prisma } from "@/infrastructure/db/client";
import { getUsMarketSession } from "@/lib/market-map/market-session";
import { computeAndCacheFactorPerformance } from "./factor-performance-cache.service";
import { runFactorEngine } from "./factor-engine.service";
import { computeAndCacheFactorExposure } from "./factor-exposure-cache.service";
import { computeAndCacheFactorAttribution } from "./factor-attribution-cache.service";
import { runJobChild } from "./job-spawner";
import type { ModelPresetName } from "@/types/factors";

/** Refresh cadence during REGULAR. The child spawn costs a few seconds of tsx
 *  boot + Prisma connect, so this is coarser than the old 60s in-process loop;
 *  warm reads are therefore at most ~this stale intraday. */
const REFRESH_INTERVAL_MS = 300_000;

/** The hot-set defaults — the combo the UI lands on by default. */
const HOT_MODEL: ModelPresetName = "MACRO14";
const HOT_WINDOW = 252;

let started = false;
let running = false;
let lastRefreshAt: string | null = null;
let lastError: string | null = null;

export interface SnapshotRunnerState {
  started: boolean;
  running: boolean;
  lastRefreshAt: string | null;
  lastError: string | null;
}

export function getSnapshotRunnerState(): SnapshotRunnerState {
  return { started, running, lastRefreshAt, lastError };
}

/**
 * The actual hot-set refresh. Runs inside the job child
 * (scripts/snapshot-refresh-hotset.ts); exported so the CLI and any manual
 * caller share one code path. Throws on failure — the CLI translates that
 * into a non-zero exit.
 */
export async function refreshHotSet(
  log: (msg: string) => void = () => {},
): Promise<void> {
  const portfolios = await prisma.portfolio.findMany({
    select: { id: true },
  });

  await computeAndCacheFactorPerformance("RETURN", "SP500");
  log("[snapshot-hotset] factor performance RETURN×SP500 cached");

  for (const { id: portfolioId } of portfolios) {
    const engineResult = await runFactorEngine({
      portfolioId,
      model: HOT_MODEL,
      window: HOT_WINDOW,
    });
    if (!engineResult) continue;
    await computeAndCacheFactorExposure(
      portfolioId,
      HOT_MODEL,
      HOT_WINDOW,
      engineResult,
    );
    await computeAndCacheFactorAttribution(
      portfolioId,
      HOT_MODEL,
      HOT_WINDOW,
      engineResult,
    );
    log(`[snapshot-hotset] portfolio ${portfolioId}: exposure + attribution cached`);
  }
}

/**
 * Start the singleton refresh loop. Idempotent — repeated calls are no-ops.
 * Fire-and-forget: never throws; swallows any error into the runner state.
 */
export function startSnapshotRefreshRunner(): void {
  if (started) return;
  started = true;
  console.log(
    `[snapshot-refresh] runner started (refresh hot set every ${REFRESH_INTERVAL_MS / 1000}s during REGULAR, via job child)`,
  );
  // Fire once on boot so a server restart mid-session warms the hot set
  // without waiting a full interval.
  void tick();
  setInterval(() => {
    void tick();
  }, REFRESH_INTERVAL_MS);
}

async function tick(): Promise<void> {
  if (running) return;
  if (getUsMarketSession(new Date()) !== "REGULAR") return;

  running = true;
  try {
    // skip-if-busy: a freshness refresh queued behind a long-running job
    // (e.g. the 10-min precompute) would be stale by the time it ran —
    // skip and let the next tick catch up instead.
    const r = await runJobChild("snapshot-hotset", "job:snapshot-hotset", [], {
      mode: "skip-if-busy",
    });
    if (r.ok) {
      lastRefreshAt = new Date().toISOString();
      lastError = null;
    } else if (!r.skipped) {
      lastError = r.error;
      console.error(`[snapshot-refresh] refresh failed: ${r.error}`);
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[snapshot-refresh] refresh failed:", e);
  } finally {
    running = false;
  }
}
