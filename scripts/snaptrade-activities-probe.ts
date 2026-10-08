/**
 * Phase 0 probe — read-only reconnaissance of SnapTrade transaction history.
 *
 * Answers the questions that size the transaction-based performance rebuild
 * before any storage/ingest code is committed to it:
 *   - How far back does the brokerage return activities, and how many rows?
 *   - Does the response paginate past the `limit` (needs a page-walk)?
 *   - What distinct `type` values appear in THIS account (drives the
 *     classifier table — guessing at it is the main risk)?
 *   - Do positions carry `cost_basis` / `tax_lots` (an opening-position
 *     cross-check)?
 *
 * NO WRITES. Prints only. Mirrors the read-only style of
 * scripts/revision-fmp-validate.ts. Exits non-zero when SnapTrade is
 * unconfigured or no linked account can be resolved.
 *
 * Usage:
 *   npx tsx scripts/snaptrade-activities-probe.ts
 *   npx tsx scripts/snaptrade-activities-probe.ts --account=<snaptradeAccountId>
 *   npx tsx scripts/snaptrade-activities-probe.ts --samples=3
 */
import { prisma } from "../src/infrastructure/db/client";
import { snaptradeConfigured } from "../src/infrastructure/config/env";
import { getSnapTradeClient } from "../src/infrastructure/providers/snaptrade/client";

function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const PAGE_LIMIT = 1000;

interface ActivityRow {
  id?: string;
  type?: string;
  units?: number;
  price?: number;
  amount?: number | null;
  fee?: number;
  trade_date?: string | null;
  settlement_date?: string;
  description?: string;
  symbol?: { symbol?: string; raw_symbol?: string; type?: { code?: string } | null } | null;
  option_symbol?: unknown;
  currency?: { code?: string } | null;
}

/** Resolve accounts to probe: DB links first, else live listUserAccounts. */
async function resolveAccountIds(explicit?: string): Promise<string[]> {
  if (explicit) return [explicit];
  const links = await prisma.brokerageAccountLink.findMany({
    select: { snaptradeAccountId: true, institutionName: true, accountMask: true },
  });
  if (links.length > 0) {
    for (const l of links) {
      console.log(
        `[probe] DB link → ${l.snaptradeAccountId} (${l.institutionName ?? "?"} …${l.accountMask ?? "????"})`,
      );
    }
    return links.map((l) => l.snaptradeAccountId);
  }
  console.log("[probe] no DB links — falling back to listUserAccounts()");
  const client = getSnapTradeClient();
  const resp = await client.accountInformation.listUserAccounts();
  return (resp.data ?? []).map((a) => a.id).filter((id): id is string => !!id);
}

async function probePositions(accountId: string): Promise<void> {
  const client = getSnapTradeClient();
  const resp = await client.accountInformation.getAllAccountPositions({ accountId });
  const results = (resp.data?.results ?? []) as Array<Record<string, unknown>>;
  console.log(`\n[positions] ${results.length} rows`);
  let withCostBasis = 0;
  let withTaxLots = 0;
  for (const p of results) {
    if (p.cost_basis != null) withCostBasis++;
    const lots = p.tax_lots;
    if (Array.isArray(lots) && lots.length > 0) withTaxLots++;
  }
  console.log(`[positions] cost_basis present on ${withCostBasis}/${results.length}`);
  console.log(`[positions] tax_lots present on ${withTaxLots}/${results.length}`);
  const sample = results[0];
  if (sample) {
    const instrument = sample.instrument as { symbol?: string } | undefined;
    console.log(
      `[positions] sample: symbol=${instrument?.symbol ?? "?"} units=${String(sample.units)} price=${String(sample.price)} cost_basis=${String(sample.cost_basis)} tax_lots=${Array.isArray(sample.tax_lots) ? (sample.tax_lots as unknown[]).length : "none"}`,
    );
  }
}

async function probeActivities(accountId: string, sampleCount: number): Promise<void> {
  const client = getSnapTradeClient();
  const all: ActivityRow[] = [];
  let offset = 0;
  let total = Infinity;
  let pages = 0;

  while (offset < total) {
    const resp = await client.accountInformation.getAccountActivities({
      accountId,
      offset,
      limit: PAGE_LIMIT,
    });
    const page = (resp.data?.data ?? []) as ActivityRow[];
    const pag = resp.data?.pagination as { offset?: number; limit?: number; total?: number } | undefined;
    total = pag?.total ?? page.length;
    all.push(...page);
    pages++;
    console.log(
      `[activities] page ${pages}: offset=${offset} got=${page.length} pagination.total=${pag?.total ?? "?"}`,
    );
    if (page.length === 0) break;
    offset += page.length;
    if (pages > 100) {
      console.warn("[activities] page cap (100) hit — stopping walk");
      break;
    }
  }

  console.log(`\n[activities] total collected: ${all.length} over ${pages} page(s)`);
  console.log(`[activities] pagination needed (total > ${PAGE_LIMIT}): ${total > PAGE_LIMIT}`);

  const dates = all
    .map((a) => a.trade_date ?? null)
    .filter((d): d is string => !!d)
    .sort();
  if (dates.length) {
    console.log(`[activities] trade_date range: ${dates[0]} → ${dates[dates.length - 1]}`);
  } else {
    console.log("[activities] no trade_date values present");
  }

  // Distinct type breakdown with valued-ability (symbol present) + field coverage.
  const byType = new Map<
    string,
    { count: number; withSymbol: number; withUnits: number; withAmount: number; withPrice: number; withOption: number }
  >();
  for (const a of all) {
    const t = a.type ?? "(null)";
    const e =
      byType.get(t) ?? { count: 0, withSymbol: 0, withUnits: 0, withAmount: 0, withPrice: 0, withOption: 0 };
    e.count++;
    if (a.symbol?.symbol) e.withSymbol++;
    if (a.units != null) e.withUnits++;
    if (a.amount != null) e.withAmount++;
    if (a.price != null) e.withPrice++;
    if (a.option_symbol != null) e.withOption++;
    byType.set(t, e);
  }
  console.log("\n[activities] distinct type breakdown:");
  for (const [t, e] of [...byType.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(
      `  ${t.padEnd(28)} n=${String(e.count).padStart(5)}  symbol=${e.withSymbol}  units=${e.withUnits}  price=${e.withPrice}  amount=${e.withAmount}  option=${e.withOption}`,
    );
  }

  // Coverage of the `id` field (unique-key stability for write-once storage).
  const withId = all.filter((a) => a.id).length;
  console.log(`\n[activities] rows with stable id: ${withId}/${all.length}`);

  // A couple of raw sample rows per type so the classifier can be written
  // against real shapes rather than the SDK doc's example list.
  console.log(`\n[activities] ${sampleCount} sample row(s) per type:`);
  for (const t of byType.keys()) {
    const samples = all.filter((a) => (a.type ?? "(null)") === t).slice(0, sampleCount);
    for (const s of samples) {
      console.log(
        `  [${t}] date=${s.trade_date ?? "?"} sym=${s.symbol?.symbol ?? s.symbol?.raw_symbol ?? "-"} units=${s.units ?? "-"} price=${s.price ?? "-"} amount=${s.amount ?? "-"} fee=${s.fee ?? "-"} ccy=${s.currency?.code ?? "-"} desc="${(s.description ?? "").slice(0, 60)}"`,
      );
    }
  }
}

async function main() {
  if (!snaptradeConfigured()) {
    console.error("[probe] SnapTrade not configured (SNAPTRADE_CLIENT_ID / SNAPTRADE_CONSUMER_KEY).");
    process.exit(2);
  }
  const sampleCount = Number(opt("samples") ?? "2");
  const accountIds = await resolveAccountIds(opt("account"));
  if (accountIds.length === 0) {
    console.error("[probe] no SnapTrade accounts found (no DB link and listUserAccounts empty).");
    process.exit(3);
  }
  console.log(`[probe] probing ${accountIds.length} account(s)`);
  for (const accountId of accountIds) {
    console.log(`\n${"=".repeat(72)}\n[probe] account ${accountId}\n${"=".repeat(72)}`);
    try {
      await probePositions(accountId);
    } catch (e) {
      console.error(`[positions] failed:`, e instanceof Error ? e.message : e);
    }
    try {
      await probeActivities(accountId, sampleCount);
    } catch (e) {
      console.error(`[activities] failed:`, e instanceof Error ? e.message : e);
    }
  }
}

main()
  .catch((e) => {
    console.error("[snaptrade-activities-probe] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
