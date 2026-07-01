/**
 * Engine 3 — quarterly ingestion + aggregation job (CLI entry point).
 *
 * 13F settles ~45 days after quarter-end, so this runs quarterly. Ingestion is
 * idempotent and history is fully backfillable, so --quarters controls depth.
 *
 *   npx tsx scripts/institutional-quarterly.ts                 # 12q refresh + aggregate
 *   npx tsx scripts/institutional-quarterly.ts --quarters=8
 *   npx tsx scripts/institutional-quarterly.ts --ingest-only
 *   npx tsx scripts/institutional-quarterly.ts --aggregate-only
 *   npx tsx scripts/institutional-quarterly.ts --cik=0001067983 # one fund (debug)
 *
 * Logic lives in src/server/services/institutional/*. Exit 0 ok, 1 on fatal.
 */
import { prisma } from "../src/infrastructure/db/client";
import { runInstitutionalIngest } from "../src/server/services/institutional/institutional-ingest.service";
import { runInstitutionalAggregate } from "../src/server/services/institutional/institutional-aggregate.service";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const log = (msg: string) => console.log(msg);
  const quarters = opt("quarters") ? Number(opt("quarters")) : 12;

  if (!flag("aggregate-only")) {
    const ingest = await runInstitutionalIngest({ quarters, onlyCik: opt("cik"), log });
    console.log("[institutional-quarterly] ingest:", JSON.stringify(ingest, null, 2));
  }
  if (!flag("ingest-only")) {
    const agg = await runInstitutionalAggregate({ log });
    console.log("[institutional-quarterly] aggregate:", JSON.stringify(agg, null, 2));
  }
}

main()
  .catch((e) => {
    console.error("[institutional-quarterly] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
