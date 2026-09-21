/**
 * Pairs tab — Phase 0 probe (READ-ONLY).
 *
 * Decides what the short side of the Hedge Finder can honestly ship, before
 * any storage/ingest is committed. The brief (§11) requires probing the actual
 * universe — especially small/mid-caps — for the data the short-side gates and
 * the ETF-contains-target check depend on, none of which has a fetcher in the
 * repo today:
 *   - Short interest / % of float  (no FMP fetcher exists; only Yahoo shortRatio
 *     days-to-cover on portfolio holdings via SecurityFundamentals)
 *   - Shares float                 (needed to turn short interest into % float)
 *   - ETF holdings / constituents  (needed for the contains-target weight, §7.3)
 *   - Daily volume / ADV           (PriceHistory.volume is written null, §ADV inert)
 *   - Next-earnings coverage       (both legs, §7.7)
 *   - Subsector taxonomy stability (basket-membership churn, §4.2)
 *
 * Makes only HTTP GETs to FMP + reads from the DB. Writes nothing.
 * Mirrors the read-only style of scripts/snaptrade-activities-probe.ts.
 *
 * Usage:
 *   npx tsx scripts/pairs-probe.ts
 *   npx tsx scripts/pairs-probe.ts --sample=60
 *   FMP_API_KEY=... npx tsx scripts/pairs-probe.ts
 */
import { prisma } from "../src/infrastructure/db/client";
import { fmpApiKey } from "../src/infrastructure/config/env";
import {
  fmpGetJson,
  FmpAuthError,
  FmpEntitlementError,
  FmpRequestError,
} from "../src/infrastructure/providers/fmp/fmp-client";

function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const SAMPLE_SIZE = Number(opt("sample") ?? "60");
// ETFs the Hedge Finder would offer as basket shorts (§7.3, §9.3).
const ETF_PROBES = ["XLI", "ITA", "XAR", "XLK", "SMH", "IGV"];

interface EndpointOutcome {
  path: string;
  status: "OK" | "EMPTY" | "ENTITLEMENT" | "AUTH" | "ERROR";
  count: number;
  firstKeys?: string[];
  note?: string;
}

/** Try an FMP path and classify the outcome without throwing. */
async function probeEndpoint(path: string, params: Record<string, string | number>): Promise<EndpointOutcome> {
  try {
    const body = await fmpGetJson<unknown>(path, params);
    if (Array.isArray(body)) {
      const first = body[0];
      return {
        path,
        status: body.length ? "OK" : "EMPTY",
        count: body.length,
        firstKeys: first && typeof first === "object" ? Object.keys(first as object).slice(0, 12) : undefined,
      };
    }
    if (body && typeof body === "object") {
      return { path, status: "OK", count: 1, firstKeys: Object.keys(body as object).slice(0, 12) };
    }
    return { path, status: "EMPTY", count: 0 };
  } catch (e) {
    if (e instanceof FmpEntitlementError) return { path, status: "ENTITLEMENT", count: 0, note: "HTTP 402 — add-on not subscribed" };
    if (e instanceof FmpAuthError) return { path, status: "AUTH", count: 0, note: e.message };
    if (e instanceof FmpRequestError) return { path, status: "ERROR", count: 0, note: e.message.slice(0, 120) };
    return { path, status: "ERROR", count: 0, note: e instanceof Error ? e.message.slice(0, 120) : String(e) };
  }
}

function printOutcome(label: string, o: EndpointOutcome): void {
  const head = `  ${label.padEnd(22)} ${o.status.padEnd(11)} n=${String(o.count).padStart(5)}  ${o.path}`;
  console.log(head);
  if (o.firstKeys) console.log(`      keys: ${o.firstKeys.join(", ")}`);
  if (o.note) console.log(`      note: ${o.note}`);
}

/** Pull a small/mid-cap-skewed sample of tickers from the revision reference. */
async function loadSample(): Promise<Array<{ ticker: string; marketCap: number | null; subsector: string | null; sector: string | null }>> {
  const refs = await prisma.revisionReference.findMany({
    where: { isActive: true },
    select: { ticker: true, marketCap: true, subsector: true, sector: true },
  });
  const withCap = refs
    .map((r) => ({
      ticker: r.ticker,
      marketCap: r.marketCap === null ? null : Number(r.marketCap),
      subsector: r.subsector,
      sector: r.sector,
    }))
    .filter((r) => r.marketCap !== null && Number.isFinite(r.marketCap))
    .sort((a, b) => (a.marketCap ?? 0) - (b.marketCap ?? 0));
  if (withCap.length === 0) return refs.slice(0, SAMPLE_SIZE).map((r) => ({ ticker: r.ticker, marketCap: null, subsector: r.subsector, sector: r.sector }));
  // Skew small/mid: take the bottom two-thirds of the cap distribution.
  const pool = withCap.slice(0, Math.max(SAMPLE_SIZE, Math.floor(withCap.length * 0.66)));
  const step = Math.max(1, Math.floor(pool.length / SAMPLE_SIZE));
  const picked: typeof pool = [];
  for (let i = 0; i < pool.length && picked.length < SAMPLE_SIZE; i += step) picked.push(pool[i]!);
  return picked;
}

async function probeShortInterestAndFloat(tickers: string[]): Promise<void> {
  console.log(`\n${"=".repeat(72)}\n[1] SHORT INTEREST + FLOAT (no fetcher in repo — candidate endpoints)\n${"=".repeat(72)}`);
  // Try the few plausible FMP paths on ONE ticker first to find which exist.
  const t = tickers[0]!;
  const candidates: Array<[string, string, Record<string, string | number>]> = [
    ["short-interest", "/stable/short-interest", { symbol: t }],
    ["shares-float", "/stable/shares-float", { symbol: t }],
    ["float (legacy)", "/api/v4/shares_float", { symbol: t }],
    ["short-vol", "/stable/short-interest-volume", { symbol: t }],
  ];
  const live: string[] = [];
  for (const [label, path, params] of candidates) {
    const o = await probeEndpoint(path, params);
    printOutcome(label, o);
    if (o.status === "OK") live.push(path);
  }
  // Coverage of the first live short-interest/float path across the sample.
  for (const path of live) {
    let hit = 0;
    for (const tk of tickers) {
      const o = await probeEndpoint(path, { symbol: tk });
      if (o.status === "OK" && o.count > 0) hit++;
    }
    console.log(`  → ${path} coverage: ${hit}/${tickers.length} sample names`);
  }
  if (live.length === 0) {
    console.log("  VERDICT: no FMP short-interest/float endpoint responded — short-side single-name gates NOT buildable; ship basket/ETF shorts only.");
  }
}

async function probeEtfHoldings(): Promise<void> {
  console.log(`\n${"=".repeat(72)}\n[2] ETF HOLDINGS (needed for contains-target weight, §7.3)\n${"=".repeat(72)}`);
  const candidates: Array<[string, string, Record<string, string | number>]> = [
    ["etf-holdings", "/stable/etf/holdings", { symbol: ETF_PROBES[0]! }],
    ["etf-holdings alt", "/stable/etf-holdings", { symbol: ETF_PROBES[0]! }],
    ["etf-holder (legacy)", "/api/v3/etf-holder", { symbol: ETF_PROBES[0]! }],
  ];
  const live: string[] = [];
  for (const [label, path, params] of candidates) {
    const o = await probeEndpoint(path, params);
    printOutcome(label, o);
    if (o.status === "OK") live.push(path);
  }
  if (live.length) {
    for (const etf of ETF_PROBES) {
      const o = await probeEndpoint(live[0]!, { symbol: etf });
      console.log(`  ${etf.padEnd(6)} holdings=${o.count} via ${live[0]}`);
    }
  } else {
    console.log("  VERDICT: no ETF-holdings endpoint responded — cannot show ETF-contains-target weight; label the check unavailable.");
  }
}

async function probeVolume(tickers: string[]): Promise<void> {
  console.log(`\n${"=".repeat(72)}\n[3] VOLUME / ADV (PriceHistory.volume written null today)\n${"=".repeat(72)}`);
  const secs = await prisma.security.findMany({ where: { ticker: { in: tickers } }, select: { id: true, ticker: true } });
  const ids = secs.map((s) => s.id);
  const withVol = await prisma.priceHistory.count({ where: { securityId: { in: ids }, volume: { not: null } } });
  const total = await prisma.priceHistory.count({ where: { securityId: { in: ids } } });
  console.log(`  PriceHistory.volume populated on ${withVol}/${total} sample bars`);
  // Does FMP's EOD /full payload carry volume we currently discard?
  const t = tickers[0]!;
  const o = await probeEndpoint("/stable/historical-price-eod/full", { symbol: t, from: "2026-08-01", to: "2026-09-01" });
  printOutcome("fmp eod /full", o);
  const carriesVolume = o.firstKeys?.includes("volume");
  console.log(`  FMP eod /full carries a 'volume' field: ${carriesVolume ? "YES (ingest could populate it)" : "no/unknown"}`);
}

async function probeEarnings(tickers: string[]): Promise<void> {
  console.log(`\n${"=".repeat(72)}\n[4] NEXT-EARNINGS COVERAGE (both legs, §7.7)\n${"=".repeat(72)}`);
  const latest = await prisma.revisionSnapshot.aggregate({ _max: { snapshotDate: true } });
  const d = latest._max.snapshotDate;
  if (!d) {
    console.log("  no RevisionSnapshot rows found.");
    return;
  }
  const rows = await prisma.revisionSnapshot.findMany({
    where: { snapshotDate: d, ticker: { in: tickers } },
    select: { ticker: true, nextEarningsDate: true },
  });
  const withDate = rows.filter((r) => r.nextEarningsDate !== null).length;
  console.log(`  nextEarningsDate present on ${withDate}/${rows.length} sample names (as of ${d.toISOString().slice(0, 10)})`);
}

async function probeTaxonomy(): Promise<void> {
  console.log(`\n${"=".repeat(72)}\n[5] SUBSECTOR TAXONOMY STABILITY (basket-membership churn, §4.2)\n${"=".repeat(72)}`);
  const refs = await prisma.revisionReference.findMany({
    where: { isActive: true },
    select: { subsector: true, sector: true },
  });
  const bySub = new Map<string, number>();
  for (const r of refs) {
    const k = r.subsector ?? r.sector ?? "Unclassified";
    bySub.set(k, (bySub.get(k) ?? 0) + 1);
  }
  const enough = [...bySub.values()].filter((n) => n >= 8).length;
  console.log(`  subsectors total: ${bySub.size}; with >= 8 names (Tier-1 eligible): ${enough}`);
  // How many distinct subsector strings appear on RevisionScreenRow historically
  // vs today's reference — a proxy for whether backfilled membership is stable.
  const distinctHist = await prisma.revisionScreenRow.findMany({
    distinct: ["subsector"],
    select: { subsector: true },
  });
  console.log(`  distinct subsector strings in RevisionScreenRow history: ${distinctHist.length}`);
  console.log("  NOTE: RevisionScreenRow.subsector on backfilled weeks is stamped from TODAY's reference,");
  console.log("        so historical Tier-1 baskets carry membershipBasis=CURRENT_TAXONOMY (labelled, not silent).");
}

async function main() {
  if (!fmpApiKey()) {
    console.error("[pairs-probe] FMP_API_KEY not set.");
    process.exit(2);
  }
  const sample = await loadSample();
  const tickers = sample.map((s) => s.ticker);
  console.log(`[pairs-probe] sample of ${tickers.length} small/mid-cap-skewed names`);
  const caps = sample.filter((s) => s.marketCap !== null).map((s) => s.marketCap!);
  if (caps.length) {
    const med = caps.sort((a, b) => a - b)[Math.floor(caps.length / 2)]!;
    console.log(`[pairs-probe] median sample market cap: $${(med / 1e9).toFixed(2)}B`);
  }

  await probeShortInterestAndFloat(tickers);
  await probeEtfHoldings();
  await probeVolume(tickers);
  await probeEarnings(tickers);
  await probeTaxonomy();

  console.log(`\n${"=".repeat(72)}`);
  console.log("[pairs-probe] done. Use the OK/EMPTY/ENTITLEMENT verdicts above to set the short-side scope:");
  console.log("  - short-interest + float both OK on small/mids  → single-name short gates are real");
  console.log("  - either thin/absent                            → Hedge Finder ships basket + ETF shorts only");
  console.log("  - ETF holdings OK                               → enable the contains-target weight");
  console.log("  - FMP eod carries volume                        → a volume ingest is worth adding");
}

main()
  .catch((e) => {
    console.error("[pairs-probe] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
