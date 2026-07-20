/**
 * Engine 2 — DAILY earnings-driven incremental (CLI entry point).
 *
 * Child-process twin of the fundamental runner's daily path: one bulk FMP
 * earnings-calendar call finds which universe tickers reported since --since;
 * only those get their statements re-fetched. The refreshed snapshots PATCH
 * the latest EXISTING snapshotDate (never a new sparse date) so the scored
 * cohort stays full-universe, then that date is re-scored.
 *
 * Usage:
 *   npx tsx scripts/fundamental-daily.ts --since=2026-07-15
 *   npx tsx scripts/fundamental-daily.ts            # default: 3 days back
 *
 * The ticker list is derived here, NOT passed on the command line (a busy
 * earnings week would blow the Windows command-line length limit).
 *
 * Exit 0 on success (including the no-baseline / nothing-reported no-ops),
 * 1 on fatal error.
 */
import { prisma } from "../src/infrastructure/db/client";
import { fetchEarningsCalendar } from "../src/infrastructure/providers/fmp";
import { tradeDateEtFromUnix } from "../src/lib/market-map/market-session";
import { selectReportedTickers } from "../src/server/services/fundamental-runner";
import { runFundamentalWeekly } from "../src/server/services/fundamental/fundamental-weekly-job.service";
import { scoreFundamentalBoxesWeek } from "../src/server/services/fundamental/fundamental-box-scoring.service";
import { loadActiveUniverseTickers } from "../src/server/services/revision/reference-ingest.service";

/** Calendar lookback when --since is not given (mirrors the runner). */
const DAILY_LOOKBACK_DAYS = 3;

function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const log = (msg: string) => console.log(msg);
  const today = tradeDateEtFromUnix(Math.floor(Date.now() / 1000));
  const since = opt("since") ?? addDaysIso(today, -DAILY_LOOKBACK_DAYS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error(`[fundamental-daily] invalid --since: ${since}`);
    process.exit(1);
  }

  const latest = await prisma.fundamentalSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  if (!latest) {
    // No baseline yet — the weekly sweep (or the manual backfill) owns it.
    console.log("[fundamental-daily] no snapshot baseline yet; nothing to patch.");
    return;
  }

  const [entries, universe] = await Promise.all([
    fetchEarningsCalendar(since, today),
    loadActiveUniverseTickers(),
  ]);
  const reported = selectReportedTickers(entries, universe, since);

  let snapshotsWritten = 0;
  if (reported.length > 0) {
    const snapshotDate = latest.snapshotDate.toISOString().slice(0, 10);
    const ingest = await runFundamentalWeekly({
      tickers: reported,
      snapshotDate,
      log,
    });
    snapshotsWritten = ingest.snapshotsWritten;
    if (ingest.snapshotsWritten > 0) {
      await scoreFundamentalBoxesWeek({ snapshotDate, log });
    }
  }
  console.log(
    `[fundamental-daily] done: ${reported.length} reported since ${since}, ${snapshotsWritten} snapshots patched`,
  );
}

main()
  .catch((e) => {
    console.error("[fundamental-daily] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
