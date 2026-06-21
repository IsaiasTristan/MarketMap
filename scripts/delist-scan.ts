/**
 * One-shot delist scan: walk every Security that's currently failing to ingest
 * (under-bar count, or a stale lastDate), run a full 10-year Yahoo pull, and:
 *   - if Yahoo returns a hard delist signal → set firstMissedAt/lastMissedAt
 *     and ratchet `consecutiveMisses`. A 10-year empty pull is enough to
 *     promote to `delistCandidate=true` on the spot.
 *   - if Yahoo returns bars → reset the miss counters.
 *   - if Yahoo throttles → no-op (don't pollute counters with transient state).
 *
 * Also fills `suggestedReplacement` from the curated rename map and Yahoo's
 * successor lookup so the Data tab review has helpful renames pre-loaded.
 *
 * Does NOT auto-deactivate (`isActive=false`). The user reviews and confirms
 * each candidate in the Data tab → Securities Health section.
 *
 * Usage:
 *   npx tsx scripts/delist-scan.ts                  # scan all securities
 *   npx tsx scripts/delist-scan.ts UNIV_ID          # scan one universe only
 */
import { prisma } from "../src/infrastructure/db/client";
import { ingestSecurityHistory } from "../src/server/services/price-ingest.service";
import { refreshSuccessorSuggestions } from "../src/server/services/security-health.service";

const STALE_CALENDAR_DAYS = 14; // anything fresher than this isn't worth scanning
const PER_REQUEST_DELAY_MS = 250; // be polite to Yahoo
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function calendarDaysBehind(lastDate: Date | null | undefined): number {
  if (!lastDate) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - lastDate.getTime()) / 86_400_000);
}

async function main() {
  const universeId = process.argv[2] || null;
  console.log(
    `[delist-scan] scope=${universeId ?? "all securities"} starting…`
  );

  const candidates = await prisma.security.findMany({
    where: universeId
      ? { universeRows: { some: { universeId } } }
      : undefined,
    include: {
      _count: { select: { priceHistory: true } },
      priceHistory: {
        select: { tradeDate: true },
        orderBy: { tradeDate: "desc" },
        take: 1,
      },
    },
    orderBy: { ticker: "asc" },
  });

  // Only re-scan tickers that look broken: <5 bars, or lastDate is more than
  // STALE_CALENDAR_DAYS behind now. Healthy tickers don't need a 10-year pull.
  const targets = candidates.filter((s) => {
    if (!s.isActive) return false; // already deactivated; nothing to do
    if (s._count.priceHistory < 5) return true;
    return calendarDaysBehind(s.priceHistory[0]?.tradeDate ?? null) > STALE_CALENDAR_DAYS;
  });

  console.log(
    `[delist-scan] ${candidates.length} securities, ${targets.length} look broken — scanning each.`
  );

  const summary = {
    flagged: [] as string[],
    delistedSignal: [] as string[],
    okAfterScan: [] as string[],
    throttled: [] as string[],
    inactive: [] as string[],
  };

  for (const s of targets) {
    try {
      const r = await ingestSecurityHistory(prisma, s.ticker, 10);
      if (r.kind === "ok") {
        summary.okAfterScan.push(`${s.ticker} (${r.bars} bars)`);
      } else if (r.kind === "delisted-signal") {
        summary.delistedSignal.push(`${s.ticker} — ${r.reason}`);
        if (r.flagged) summary.flagged.push(s.ticker);
      } else if (r.kind === "throttled") {
        summary.throttled.push(`${s.ticker} — ${r.reason}`);
      } else if (r.kind === "skipped-inactive") {
        summary.inactive.push(s.ticker);
      }
    } catch (e) {
      summary.throttled.push(
        `${s.ticker} — exception: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    await sleep(PER_REQUEST_DELAY_MS);
  }

  console.log("[delist-scan] filling successor suggestions…");
  const fill = await refreshSuccessorSuggestions(prisma);
  console.log(`[delist-scan] suggestions filled: ${fill.filled}`);

  console.log("");
  console.log("=== Summary ===");
  console.log(
    `OK after rescan:        ${summary.okAfterScan.length}`
  );
  console.log(`Delisted signal:        ${summary.delistedSignal.length}`);
  console.log(`  → flagged candidate:  ${summary.flagged.length}`);
  console.log(`Throttled (no change):  ${summary.throttled.length}`);
  console.log(`Already inactive:       ${summary.inactive.length}`);
  if (summary.flagged.length > 0) {
    console.log("");
    console.log("Flagged for review (visit Data tab → Securities Health):");
    for (const t of summary.flagged) console.log(`  - ${t}`);
  }
  if (summary.delistedSignal.length > summary.flagged.length) {
    console.log("");
    console.log("Delisted signal but not yet at threshold:");
    for (const line of summary.delistedSignal) {
      const tk = line.split(" — ")[0];
      if (!summary.flagged.includes(tk!)) console.log(`  - ${line}`);
    }
  }
  if (summary.throttled.length > 0) {
    console.log("");
    console.log("Throttled (Yahoo rate-limit) — re-run later:");
    for (const line of summary.throttled.slice(0, 20)) console.log(`  - ${line}`);
    if (summary.throttled.length > 20) {
      console.log(`  …and ${summary.throttled.length - 20} more`);
    }
  }
}

main()
  .catch((e) => {
    console.error("[delist-scan] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
