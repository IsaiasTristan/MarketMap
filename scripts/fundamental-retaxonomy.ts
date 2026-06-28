/**
 * One-shot: rebuild RevisionReference from the market-map universe (SNP 2
 * sector / sub-theme taxonomy) and re-score the fundamentals discovery queue
 * so deciles, peer z-scores, and sector aggregates use the user's groups.
 *
 * Does NOT re-pull FMP statements — only relabels + recomputes scores.
 *
 * Usage:
 *   npx tsx scripts/fundamental-retaxonomy.ts
 *   npx tsx scripts/fundamental-retaxonomy.ts --universeId=<id>
 */
import { prisma } from "../src/infrastructure/db/client";
import {
  buildReferenceFromMarketMap,
  loadActiveUniverseTickers,
} from "../src/server/services/revision/reference-ingest.service";
import { scoreFundamentalBoxesWeek } from "../src/server/services/fundamental/fundamental-box-scoring.service";

function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const log = (msg: string) => console.log(msg);
  const universeId = opt("universeId");

  log("[fundamental-retaxonomy] rebuilding reference from market-map universe…");
  const ref = await buildReferenceFromMarketMap({ universeId, log });
  log(`[fundamental-retaxonomy] reference upserted ${ref.upserted}/${ref.fetched}`);

  const tickers = await loadActiveUniverseTickers();
  const latestSnap = await prisma.fundamentalSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  if (!latestSnap) {
    console.error("[fundamental-retaxonomy] no FundamentalSnapshot rows — run job:fundamental first.");
    process.exit(1);
  }

  const snapDate = latestSnap.snapshotDate;
  const withFundamentals = await prisma.fundamentalSnapshot.count({
    where: { snapshotDate: snapDate, ticker: { in: tickers } },
  });
  const coveragePct = tickers.length > 0 ? ((withFundamentals / tickers.length) * 100).toFixed(1) : "0";
  log(
    `[fundamental-retaxonomy] coverage: ${withFundamentals}/${tickers.length} active tickers have snapshots (${coveragePct}%) as of ${snapDate.toISOString().slice(0, 10)}`,
  );
  if (withFundamentals < tickers.length * 0.9) {
    log(
      "[fundamental-retaxonomy] WARNING: coverage below 90% — consider `npm run job:fundamental -- --reference --backfill` to ingest missing names.",
    );
  }

  log("[fundamental-retaxonomy] re-scoring discovery queue…");
  const scored = await scoreFundamentalBoxesWeek({ snapshotDate: snapDate.toISOString().slice(0, 10), log });
  console.log("[fundamental-retaxonomy] scoring summary:", JSON.stringify(scored, null, 2));
}

main()
  .catch((e) => {
    console.error("[fundamental-retaxonomy] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
