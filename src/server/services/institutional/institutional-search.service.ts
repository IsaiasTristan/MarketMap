/**
 * Engine 3 — Fund search index + alias seed (Fund Overview Part 6). The DB seam that
 * assembles the small, client-shippable fund index (official name + aliases + CIK +
 * category + tier + 13F AUM + saved flag) consumed by the pure fund-search matcher.
 */
import { prisma } from "@/infrastructure/db/client";
import { type FundIndexEntry, type FundTierValue } from "@/lib/institutional/fund-search";

/** Seed aliases keyed by a case-insensitive substring of the fund's name/edgarName.
 *  Only funds present in the DB get rows; idempotent (skipDuplicates). */
const ALIAS_SEED: Array<{ match: string; aliases: Array<{ alias: string; kind: string }> }> = [
  { match: "GAMCO", aliases: [{ alias: "Gabelli", kind: "manager" }] },
  { match: "Gabelli", aliases: [{ alias: "GAMCO", kind: "short" }] },
  { match: "Harris Associates", aliases: [{ alias: "Oakmark", kind: "short" }] },
  { match: "Berkshire", aliases: [{ alias: "Buffett", kind: "manager" }, { alias: "Warren Buffett", kind: "manager" }] },
  { match: "Pershing Square", aliases: [{ alias: "Ackman", kind: "manager" }, { alias: "Bill Ackman", kind: "manager" }] },
  { match: "Duquesne", aliases: [{ alias: "Druckenmiller", kind: "manager" }] },
  { match: "Soros", aliases: [{ alias: "Soros", kind: "manager" }] },
  { match: "Appaloosa", aliases: [{ alias: "Tepper", kind: "manager" }, { alias: "David Tepper", kind: "manager" }] },
  { match: "Greenlight", aliases: [{ alias: "Einhorn", kind: "manager" }, { alias: "David Einhorn", kind: "manager" }] },
  { match: "Third Point", aliases: [{ alias: "Loeb", kind: "manager" }, { alias: "Dan Loeb", kind: "manager" }] },
  { match: "Baupost", aliases: [{ alias: "Klarman", kind: "manager" }, { alias: "Seth Klarman", kind: "manager" }] },
  { match: "Icahn", aliases: [{ alias: "Carl Icahn", kind: "manager" }] },
  { match: "Tiger Global", aliases: [{ alias: "Coleman", kind: "manager" }, { alias: "Chase Coleman", kind: "manager" }] },
  { match: "Scion", aliases: [{ alias: "Burry", kind: "manager" }, { alias: "Michael Burry", kind: "manager" }] },
  { match: "Bridgewater", aliases: [{ alias: "Dalio", kind: "manager" }, { alias: "Ray Dalio", kind: "manager" }] },
  { match: "Renaissance", aliases: [{ alias: "RenTec", kind: "short" }, { alias: "Medallion", kind: "short" }] },
];

export async function seedFundAliases(log?: (m: string) => void): Promise<number> {
  const funds = await prisma.institutionalFund.findMany({ select: { id: true, name: true, edgarName: true } });
  const rows: Array<{ fundId: string; alias: string; kind: string }> = [];
  for (const seed of ALIAS_SEED) {
    const needle = seed.match.toLowerCase();
    const matched = funds.filter(
      (f) => f.name.toLowerCase().includes(needle) || (f.edgarName?.toLowerCase().includes(needle) ?? false),
    );
    for (const f of matched) for (const a of seed.aliases) rows.push({ fundId: f.id, alias: a.alias, kind: a.kind });
  }
  if (rows.length === 0) {
    log?.("[institutional] fund aliases: no matches to seed");
    return 0;
  }
  const res = await prisma.fundAlias.createMany({ data: rows, skipDuplicates: true });
  log?.(`[institutional] fund aliases: seeded ${res.count} (of ${rows.length} candidates)`);
  return res.count;
}

/** Build the full client-shippable fund search index. */
export async function getFundSearchIndex(): Promise<FundIndexEntry[]> {
  const [funds, aliasRows, savedRows] = await Promise.all([
    prisma.institutionalFund.findMany({
      where: { isActive: true },
      select: { id: true, cik: true, name: true, category: true, tier: true, isMostRespected: true },
    }),
    prisma.fundAlias.findMany({ select: { fundId: true, alias: true } }),
    // Funds in the default "My Funds" set are "saved".
    prisma.peerSetMember.findMany({ where: { peerSet: { isDefault: true } }, select: { fundId: true } }),
  ]);

  // Latest 13F AUM per fund (max filingPeriod's marketValue).
  const books = await prisma.$queryRaw<Array<{ fundId: string; mv: number | null }>>`
    SELECT DISTINCT ON (b."fundId") b."fundId" AS "fundId", b."marketValue"::float8 AS mv
    FROM "FundBookSnapshot" b
    ORDER BY b."fundId", b."filingPeriod" DESC`;
  const aumByFund = new Map(books.map((b) => [b.fundId, b.mv]));

  const aliasesByFund = new Map<string, string[]>();
  for (const a of aliasRows) (aliasesByFund.get(a.fundId) ?? aliasesByFund.set(a.fundId, []).get(a.fundId)!).push(a.alias.toLowerCase());
  const saved = new Set(savedRows.map((s) => s.fundId));

  return funds.map((f) => ({
    cik: f.cik,
    name: f.name,
    category: f.category,
    tier: f.tier as FundTierValue,
    isElite: f.isMostRespected,
    aum13fUsd: aumByFund.get(f.id) ?? null,
    saved: saved.has(f.id),
    aliases: aliasesByFund.get(f.id) ?? [],
  }));
}
