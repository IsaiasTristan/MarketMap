/**
 * Engine 3 — Peer sets + style vectors (Fund Overview Part 2). The DB seam over the
 * pure peer-comparison core.
 *
 *  - runStyleVectorPrecompute: per (signal fund, quarter) style vector (sector mix,
 *    size-band mix, top-10 concentration, turnover, median tenure), z-scored within the
 *    tier that quarter, and the top twins_k cosine neighbours. Recomputed quarterly.
 *  - PeerSet CRUD + seedDefaultPeerSet ("My Funds" = all signal funds; create-if-absent
 *    so a job re-run never clobbers user edits) + resolvePeerSet (custom set id |
 *    CATEGORY | STYLE_TWINS → member fund ids).
 *
 * Style vectors need FundBookSnapshot.medianBookTenure, so this runs AFTER
 * runCoreHoldingsPrecompute in the pipeline.
 */
import { prisma } from "@/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import { styleMatrix, topTwins, type StyleComponents, type Twin } from "@/domain/calculations/peer-comparison";
import { FUND_OVERVIEW_CONFIG, type FundOverviewConfig } from "@/domain/calculations/fund-overview-config";
import { bumpIngredientsVersion } from "./institutional-ingredients.service";

const iso = (d: Date | string): string => (typeof d === "string" ? d : d.toISOString()).slice(0, 10);
/** Size bands in a fixed column order; matches InstitutionalNameAggregate.marketCapTier. */
const SIZE_BANDS = ["mega", "large", "mid", "small", "unknown"] as const;

interface HoldRow {
  fundId: string;
  period: string;
  ticker: string;
  value: number;
  pct: number | null;
}

export async function runStyleVectorPrecompute(
  log: (m: string) => void,
  cfg: FundOverviewConfig = FUND_OVERVIEW_CONFIG,
): Promise<{ rows: number }> {
  // Signal-tier holdings across all periods.
  const rows = await prisma.$queryRaw<HoldRow[]>(Prisma.sql`
    SELECT h."fundId" AS "fundId", h."filingPeriod" AS period, h.ticker,
           h.value::float8 AS value, h."pctOfBook" AS pct
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isActive" = true AND f."tier" = 'signal'
    WHERE h.shares > 0 AND h.value > 0`);
  if (rows.length === 0) {
    log("[institutional-agg] style vectors: no signal holdings");
    return { rows: 0 };
  }

  // (ticker, period) → { sector, band }. Fall back to latest-known sector when a
  // period row is missing (a name aggregate gap shouldn't blank the mix).
  const nameRows = await prisma.institutionalNameAggregate.findMany({
    select: { ticker: true, filingPeriod: true, sector: true, marketCapTier: true },
  });
  const sectorAt = new Map<string, string>(); // `${ticker}|${period}`
  const bandAt = new Map<string, string>();
  const sectorSet = new Set<string>();
  for (const n of nameRows) {
    const key = `${n.ticker}|${iso(n.filingPeriod)}`;
    const sector = n.sector ?? "Unclassified";
    sectorAt.set(key, sector);
    bandAt.set(key, SIZE_BANDS.includes((n.marketCapTier ?? "") as never) ? n.marketCapTier! : "unknown");
    sectorSet.add(sector);
  }
  const SECTORS = [...sectorSet].sort();
  const sectorIdx = new Map(SECTORS.map((s, i) => [s, i]));
  const bandIdx = new Map<string, number>(SIZE_BANDS.map((b, i) => [b, i]));

  // book snapshot: (fund,period) → { turnover, medianTenure }.
  const books = await prisma.fundBookSnapshot.findMany({ select: { fundId: true, filingPeriod: true, turnover: true, medianBookTenure: true } });
  const bookAt = new Map<string, { turnover: number | null; tenure: number | null }>();
  for (const b of books) bookAt.set(`${b.fundId}|${iso(b.filingPeriod)}`, { turnover: b.turnover ?? null, tenure: b.medianBookTenure ?? null });

  // Group holdings by period → fund → positions.
  const byPeriod = new Map<string, Map<string, HoldRow[]>>();
  for (const r of rows) {
    r.period = iso(r.period as unknown as Date);
    let byFund = byPeriod.get(r.period);
    if (!byFund) byPeriod.set(r.period, (byFund = new Map()));
    (byFund.get(r.fundId) ?? byFund.set(r.fundId, []).get(r.fundId)!).push(r);
  }

  interface Built {
    fundId: string;
    period: string;
    sectorMix: number[];
    sizeBandMix: number[];
    top10: number;
    turnover: number;
    medianTenure: number;
    comp: StyleComponents;
  }

  const outRows: Prisma.FundStyleVectorCreateManyInput[] = [];

  for (const [period, byFund] of byPeriod) {
    const built: Built[] = [];
    for (const [fundId, positions] of byFund) {
      const totalVal = positions.reduce((a, p) => a + p.value, 0);
      if (!(totalVal > 0)) continue;
      const sectorMix = new Array<number>(SECTORS.length).fill(0);
      const sizeBandMix = new Array<number>(SIZE_BANDS.length).fill(0);
      for (const p of positions) {
        const w = p.value / totalVal;
        const key = `${p.ticker}|${period}`;
        const si = sectorIdx.get(sectorAt.get(key) ?? "Unclassified");
        if (si != null) sectorMix[si]! += w;
        const bi = bandIdx.get(bandAt.get(key) ?? "unknown") ?? bandIdx.get("unknown")!;
        sizeBandMix[bi]! += w;
      }
      const pcts = positions.map((p) => (p.pct ?? (p.value / totalVal) * 100)).sort((a, b) => b - a);
      const top10 = pcts.slice(0, 10).reduce((a, b) => a + b, 0) / 100; // fraction of book
      const bk = bookAt.get(`${fundId}|${period}`);
      const turnover = bk?.turnover ?? 0;
      const medianTenure = bk?.tenure ?? 0;
      const comp: StyleComponents = { sectorMix, sizeBandMix, top10, turnover, medianTenure };
      built.push({ fundId, period, sectorMix, sizeBandMix, top10, turnover, medianTenure, comp });
    }
    if (built.length === 0) continue;

    const matrix = styleMatrix(built.map((b) => b.comp), cfg.style_vector);
    const vectors = new Map(built.map((b, i) => [b.fundId, matrix[i]!]));

    built.forEach((b, i) => {
      const twins: Twin[] = topTwins(b.fundId, vectors, cfg.twins_k);
      outRows.push({
        fundId: b.fundId,
        filingPeriod: new Date(`${b.period}T00:00:00.000Z`),
        sectorMixJson: mixObject(SECTORS, b.sectorMix) as Prisma.InputJsonValue,
        sizeBandMixJson: mixObject([...SIZE_BANDS], b.sizeBandMix) as Prisma.InputJsonValue,
        top10Concentration: round4(b.top10),
        turnover: b.turnover || null,
        medianTenure: b.medianTenure || null,
        zVectorJson: matrix[i]!.map(round4) as unknown as Prisma.InputJsonValue,
        twinsJson: twins as unknown as Prisma.InputJsonValue,
      });
    });
  }

  await prisma.$transaction([
    prisma.fundStyleVector.deleteMany({}),
    ...chunk(outRows, 5000).map((c) => prisma.fundStyleVector.createMany({ data: c })),
  ]);
  await bumpIngredientsVersion();

  log(`[institutional-agg] style vectors: ${outRows.length} (fund,quarter) rows`);
  return { rows: outRows.length };
}

/** Only keep non-zero buckets in the persisted mix object. */
function mixObject(keys: string[], weights: number[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (let i = 0; i < keys.length; i++) if (weights[i]! > 0) o[keys[i]!] = round4(weights[i]!);
  return o;
}

// ── PeerSet CRUD (request-time) ────────────────────────────────────────────────

export interface PeerSetSummary {
  id: string;
  name: string;
  kind: string;
  isDefault: boolean;
  memberCount: number;
}

export async function listPeerSets(): Promise<PeerSetSummary[]> {
  const sets = await prisma.peerSet.findMany({
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: { id: true, name: true, kind: true, isDefault: true, _count: { select: { members: true } } },
  });
  return sets.map((s) => ({ id: s.id, name: s.name, kind: s.kind, isDefault: s.isDefault, memberCount: s._count.members }));
}

export async function createPeerSet(name: string, fundIds: string[] = []): Promise<string> {
  const set = await prisma.peerSet.create({ data: { name: name.trim(), kind: "custom" } });
  if (fundIds.length) {
    await prisma.peerSetMember.createMany({
      data: fundIds.map((fundId) => ({ peerSetId: set.id, fundId })),
      skipDuplicates: true,
    });
  }
  return set.id;
}

export async function addPeerSetMember(peerSetId: string, fundId: string): Promise<void> {
  await prisma.peerSetMember.upsert({
    where: { peerSetId_fundId: { peerSetId, fundId } },
    create: { peerSetId, fundId },
    update: {},
  });
}

export async function removePeerSetMember(peerSetId: string, fundId: string): Promise<void> {
  await prisma.peerSetMember.deleteMany({ where: { peerSetId, fundId } });
}

/** Seed the default "My Funds" peer set from all signal-tier funds — create-if-absent
 *  only, so a job re-run never clobbers user membership edits. */
export async function seedDefaultPeerSet(log?: (m: string) => void): Promise<void> {
  const existing = await prisma.peerSet.findFirst({ where: { isDefault: true }, select: { id: true } });
  if (existing) return;
  const signal = await prisma.institutionalFund.findMany({ where: { isActive: true, tier: "signal" }, select: { id: true } });
  const set = await prisma.peerSet.create({ data: { name: "My Funds", kind: "default", isDefault: true } });
  if (signal.length) {
    await prisma.peerSetMember.createMany({ data: signal.map((f) => ({ peerSetId: set.id, fundId: f.id })), skipDuplicates: true });
  }
  log?.(`[institutional-agg] seeded default peer set "My Funds" (${signal.length} signal funds)`);
}

export type PeerSelector = { mode: "SET"; id: string } | { mode: "CATEGORY" } | { mode: "STYLE_TWINS" };

/**
 * Resolve a peer selector to member fund ids (excluding the subject fund). CATEGORY =
 * signal funds sharing the subject's category; STYLE_TWINS = the fund's precomputed
 * cosine neighbours for the given period.
 */
export async function resolvePeerSet(sel: PeerSelector, fundId: string, period: string): Promise<string[]> {
  if (sel.mode === "SET") {
    const members = await prisma.peerSetMember.findMany({ where: { peerSetId: sel.id }, select: { fundId: true } });
    return members.map((m) => m.fundId).filter((id) => id !== fundId);
  }
  if (sel.mode === "CATEGORY") {
    const self = await prisma.institutionalFund.findUnique({ where: { id: fundId }, select: { category: true } });
    if (!self) return [];
    const peers = await prisma.institutionalFund.findMany({
      where: { isActive: true, tier: "signal", category: self.category, id: { not: fundId } },
      select: { id: true },
    });
    return peers.map((p) => p.id);
  }
  // STYLE_TWINS
  const sv = await prisma.fundStyleVector.findUnique({
    where: { fundId_filingPeriod: { fundId, filingPeriod: new Date(`${period}T00:00:00.000Z`) } },
    select: { twinsJson: true },
  });
  const twins = (sv?.twinsJson as unknown as Twin[] | null) ?? [];
  return twins.map((t) => t.fundId);
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
