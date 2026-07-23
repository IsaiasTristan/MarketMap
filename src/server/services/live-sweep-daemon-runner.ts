/**
 * Supervises the live-sweep daemon child (extended-hours sweeps, run out of the
 * web server's event loop — see scripts/live-sweep-daemon.ts).
 *
 * Started once from instrumentation on boot. The child is NOT detached, so it
 * is tied to this web process — a web restart (run-prod's supervisor) never
 * orphans it, and the next boot spawns a fresh one. On an unexpected exit it
 * respawns with a short backoff, capped to avoid a crash loop; a healthy run
 * (>2min) resets the restart budget so occasional restarts over days are fine.
 */
import { spawn, type ChildProcess } from "node:child_process";

const MAX_RESTARTS = 10;
const RESTART_DELAY_MS = 5_000;
const HEALTHY_RUN_MS = 120_000;

let started = false;
let child: ChildProcess | null = null;
let restarts = 0;
let lastSpawnAt = 0;

/** Start the daemon supervisor. Idempotent — repeated calls are no-ops. */
export function startLiveSweepDaemon(): void {
  if (started) return;
  started = true;
  console.log("[live-sweep-daemon] supervisor starting");
  spawnDaemon();
}

function spawnDaemon(): void {
  lastSpawnAt = Date.now();
  try {
    child = spawn("npm", ["run", "job:live-sweep-daemon"], {
      cwd: process.cwd(),
      shell: true,
      windowsHide: true,
      // Inherit the web process env (DATABASE_URL, FMP/Yahoo config, .env) and
      // flag the child as the daemon so extended-hours.service persists to the
      // shared file instead of expecting an in-process sweep.
      env: { ...process.env, LIVE_SWEEP_DAEMON: "1" },
      stdio: "inherit",
    });
  } catch (e) {
    console.error("[live-sweep-daemon] failed to spawn:", e);
    scheduleRestart();
    return;
  }

  console.log(`[live-sweep-daemon] spawned pid=${child.pid ?? "?"}`);

  child.on("error", (e) => {
    console.error("[live-sweep-daemon] child error:", e);
  });

  child.on("exit", (code, signal) => {
    console.error(
      `[live-sweep-daemon] exited (code=${code ?? "?"} signal=${signal ?? "?"})`,
    );
    child = null;
    // A run that stayed up long enough was healthy — don't count it against the
    // crash-loop budget.
    if (Date.now() - lastSpawnAt > HEALTHY_RUN_MS) restarts = 0;
    scheduleRestart();
  });
}

function scheduleRestart(): void {
  if (restarts >= MAX_RESTARTS) {
    console.error(
      `[live-sweep-daemon] reached ${MAX_RESTARTS} restarts — giving up; the ` +
        `extended-hours overlay will be stale until the next web restart`,
    );
    return;
  }
  restarts += 1;
  setTimeout(spawnDaemon, RESTART_DELAY_MS);
}
