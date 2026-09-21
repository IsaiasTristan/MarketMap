/**
 * Pairs tab — one-shot backfill over the full revision weekly grid.
 *
 * Recomputes PairGroupSnapshot (baskets) then PairSnapshot + PairUniverseWeek
 * (oriented Tier-1 pairs) from the existing RevisionScreenRow / FundamentalPeriod
 * / InstitutionalNameAggregate / PriceHistory / FactorReturnDaily tables. Both
 * services are full-recompute + idempotent, so re-running is safe. Historical
 * weeks are stamped membershipBasis = CURRENT_TAXONOMY (basket membership
 * reflects today's taxonomy on backfilled weeks — labelled, not silent).
 *
 * Usage:
 *   npm run job:pairs-backfill
 *   npx tsx scripts/pairs-backfill.ts
 */
import { prisma } from "../src/infrastructure/db/client";
import { computeAndWritePairGroups } from "../src/server/services/pairs/pairs-group.service";
import { computeAndWritePairSnapshots } from "../src/server/services/pairs/pairs-snapshot.service";
import { computeAndWriteTier2Snapshots } from "../src/server/services/pairs/pairs-tier2.service";
import { computeAndWriteTier3ReadThroughs } from "../src/server/services/pairs/pairs-tier3.service";
import { computeAndCachePairValidation } from "../src/server/services/pairs/pairs-validation.service";

async function main() {
  const t0 = Date.now();
  const log = (m: string) => console.log(m);

  console.log("[pairs-backfill] building group snapshots…");
  const groups = await computeAndWritePairGroups({ log });
  console.log(
    `[pairs-backfill] groups: ${groups.groupRows} rows over ${groups.weeks} weeks (${groups.sectorGroups} sector + ${groups.subsectorGroups} subsector)`,
  );

  console.log("[pairs-backfill] building pair snapshots…");
  const pairs = await computeAndWritePairSnapshots({ log });
  console.log(`[pairs-backfill] pairs: ${pairs.pairRows} rows over ${pairs.weeks} weeks (latest ${pairs.latestWeek})`);

  console.log("[pairs-backfill] building Tier 2 single-stock pairs…");
  const t2 = await computeAndWriteTier2Snapshots({ log });
  console.log(
    `[pairs-backfill] tier2: ${t2.tier2Rows} rows over ${t2.weeks} weeks (${t2.screenedWeeks} screened; kill cutoff ${t2.killCutoff ?? "none"})`,
  );

  console.log("[pairs-backfill] building Tier 3 curated-link read-throughs…");
  const t3 = await computeAndWriteTier3ReadThroughs({ log });
  console.log(
    `[pairs-backfill] tier3: ${t3.links} links -> ${t3.readThroughs} read-through weeks (${t3.confirmed} confirmed, ${t3.watching} watching)`,
  );

  console.log("[pairs-backfill] computing pooled Validation event study…");
  const pv = await computeAndCachePairValidation({ log });
  console.log(
    `[pairs-backfill] validation: ${pv.events} events, ${pv.effectiveWeeks} effective weeks, headlineReady=${pv.headlineReady}`,
  );

  console.log(`[pairs-backfill] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .catch((e) => {
    console.error("[pairs-backfill] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
