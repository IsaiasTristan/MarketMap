/**
 * Daily pre-open refresh + precompute. Runs the full chain so the Factors tab
 * loads instantly with current data:
 *
 *   1. Price tail refresh   — pull the latest sessions for every universe
 *                             constituent + benchmarks (so prices reach the
 *                             last close).
 *   2. Factor pipeline      — refresh FF + macro factor returns (extends the
 *                             regression end-date past the KF/AQR publish lag).
 *   3. Per-stock grid       — precompute + cache the per-stock regression grid
 *                             for every (model, window) the UI exposes.
 *
 * Idempotent — safe to schedule (Windows Task Scheduler / cron / Vercel Cron).
 * Intended to run once daily after market close.
 *
 * Usage:
 *   npx tsx scripts/daily-precompute.ts            # default tailDays=10
 *   npx tsx scripts/daily-precompute.ts 20         # custom tailDays
 *
 * Exit codes: 0 on success, 1 on fatal error (no DB / no universes).
 *
 * Logic lives in src/server/services/factor-daily-precompute.service.ts so
 * the server-startup catch-up and this CLI share one code path.
 */
import { prisma } from "../src/infrastructure/db/client";
import { runDailyPrecompute } from "../src/server/services/factor-daily-precompute.service";

// Load .env for standalone tsx runs (Next.js loads it for the app; CLI scripts
// don't). Required so the price-tail step sees FMP_API_KEY and uses the bulk
// EOD path instead of silently falling back to the per-symbol Yahoo path.
if (!process.env.FMP_API_KEY) {
  try {
    (process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile(".env");
  } catch {
    /* .env optional */
  }
}

async function main() {
  const tailDays = Math.max(1, Number(process.argv[2] ?? "") || 10);
  const summary = await runDailyPrecompute({
    tailDays,
    log: (msg) => console.log(msg),
  });
  if (summary.prices.failures.length > 0) {
    console.log("[daily-precompute] price failures (first 10):");
    for (const line of summary.prices.failures.slice(0, 10)) console.log(`  ${line}`);
  }
}

main()
  .catch((e) => {
    console.error("[daily-precompute] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
