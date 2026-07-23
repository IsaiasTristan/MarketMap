/**
 * Live-sweep daemon — long-lived child process.
 *
 * Runs the heavy per-ticker extended-hours Yahoo sweep (one v8 chart fetch +
 * JSON parse per ~2,872 active tickers, every 60s during PRE/POST) OUT of the
 * web server's event loop. Spawned once per web-process boot by
 * live-sweep-daemon-runner with LIVE_SWEEP_DAEMON=1; each sweep is written to a
 * shared snapshot file that the web process reads via getExtendedSnapshot().
 *
 * The regular-hours sweep (bulk/light, and tightly coupled to the market-map
 * overlay bake) and the prior-session sweep (once per trading day) stay in the
 * web process — only this per-minute per-ticker sweep is offloaded.
 *
 * Env (DATABASE_URL, FMP/Yahoo config, LIVE_SWEEP_DAEMON) is inherited from the
 * spawning web process. Usage by hand (rarely needed):
 *   LIVE_SWEEP_DAEMON=1 npx tsx scripts/live-sweep-daemon.ts
 */
import { prisma } from "../src/infrastructure/db/client";
import { startExtendedHoursRunner } from "../src/server/services/extended-hours-runner";

console.log(
  "[live-sweep-daemon] starting (extended-hours sweeps, LIVE_SWEEP_DAEMON=%s)",
  process.env.LIVE_SWEEP_DAEMON ?? "0",
);

// The runner's setInterval keeps this process alive.
startExtendedHoursRunner();

async function shutdown(signal: string): Promise<void> {
  console.log(`[live-sweep-daemon] ${signal} — shutting down`);
  try {
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
