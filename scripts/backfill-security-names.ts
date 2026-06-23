/**
 * One-shot backfill: populate Security.name from Yahoo for rows where the
 * stored name is still the ticker (typically holdings added via the portfolio
 * builder without a universe import).
 *
 * Polite sequential fetch (350ms gap) to avoid Yahoo 429 throttling.
 * Skips on failure — never overwrites with the ticker.
 *
 *   npx tsx scripts/backfill-security-names.ts
 *   npm run job:backfill-names
 */
import { prisma } from "../src/infrastructure/db/client";
import { fetchYahooDisplayName } from "../src/infrastructure/providers/yahoo-chart-http";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isTickerLikeName(name: string, ticker: string): boolean {
  return name.trim().toUpperCase() === ticker.trim().toUpperCase();
}

async function main() {
  const securities = await prisma.security.findMany({
    select: { id: true, ticker: true, name: true },
  });
  const targets = securities.filter((s) => isTickerLikeName(s.name, s.ticker));
  console.log(
    `[backfill-names] ${targets.length}/${securities.length} securities need a real name`,
  );

  let updated = 0;
  let skipped = 0;
  for (const s of targets) {
    const yahooName = await fetchYahooDisplayName(s.ticker);
    if (yahooName && !isTickerLikeName(yahooName, s.ticker)) {
      await prisma.security.update({
        where: { id: s.id },
        data: { name: yahooName },
      });
      updated++;
      console.log(`  ${s.ticker} -> ${yahooName}`);
    } else {
      skipped++;
    }
    await sleep(350);
  }

  console.log(`[backfill-names] done: updated=${updated} skipped=${skipped}`);
}

main()
  .catch((e) => {
    console.error("[backfill-names] failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
