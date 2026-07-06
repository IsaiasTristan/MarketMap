/**
 * Engine 1 — reference / universe builder. Populates RevisionReference from the
 * FMP company-screener (US common stock, major exchanges, market-cap floor,
 * actively trading), optionally enriching CIK/identifiers via per-symbol
 * profile. Decoupled from the market-map Universe/Security tables.
 */
import { prisma } from "@/infrastructure/db/client";
import { getOrCreateDefaultUniverse } from "@/server/services/universe.service";
import { loadAllHeldTickers } from "@/server/services/position.service";
import {
  fetchProfile,
  fetchScreener,
  fmpPool,
  screenerToReference,
  type NormalizedReference,
} from "@/infrastructure/providers/fmp";

const DEFAULT_EXCHANGES = ["NASDAQ", "NYSE", "AMEX"];
const DEFAULT_MARKET_CAP_FLOOR = 300_000_000;
const DEFAULT_MAX_UNIVERSE = 3000;

export interface ReferenceRefreshOptions {
  exchanges?: string[];
  marketCapFloor?: number;
  maxUniverse?: number;
  /** Enrich rows missing a CIK via per-symbol profile (slow; default off). */
  enrichProfiles?: boolean;
  log?: (msg: string) => void;
}

export interface ReferenceRefreshSummary {
  fetched: number;
  upserted: number;
  enriched: number;
  failures: string[];
}

function dedupeByTicker(refs: NormalizedReference[]): NormalizedReference[] {
  const byTicker = new Map<string, NormalizedReference>();
  for (const r of refs) {
    if (!r.ticker) continue;
    const existing = byTicker.get(r.ticker);
    if (!existing || (r.marketCap ?? 0) > (existing.marketCap ?? 0)) byTicker.set(r.ticker, r);
  }
  return [...byTicker.values()];
}

export async function refreshRevisionReference(
  opts: ReferenceRefreshOptions = {},
): Promise<ReferenceRefreshSummary> {
  const log = opts.log ?? (() => {});
  const exchanges = opts.exchanges ?? DEFAULT_EXCHANGES;
  const floor = opts.marketCapFloor ?? DEFAULT_MARKET_CAP_FLOOR;
  const max = opts.maxUniverse ?? DEFAULT_MAX_UNIVERSE;
  const failures: string[] = [];

  const raw: NormalizedReference[] = [];
  for (const exchange of exchanges) {
    try {
      const rows = await fetchScreener({
        marketCapMoreThan: floor,
        exchange,
        country: "US",
        isActivelyTrading: true,
        isEtf: false,
        isFund: false,
        limit: 10_000,
      });
      log(`[reference] screener ${exchange}: ${rows.length} rows`);
      for (const r of rows) raw.push(screenerToReference(r));
    } catch (e) {
      failures.push(`screener ${exchange}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const universe = dedupeByTicker(raw)
    .filter((r) => r.ticker && r.companyName)
    .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
    .slice(0, max);
  log(`[reference] universe after dedupe/cap: ${universe.length}`);

  let enriched = 0;
  if (opts.enrichProfiles) {
    const { results, failures: profFailures } = await fmpPool(
      universe,
      async (r) => ({ ticker: r.ticker, profile: await fetchProfile(r.ticker) }),
      { concurrency: 8 },
    );
    const profileByTicker = new Map(results.map((x) => [x.value.ticker, x.value.profile]));
    for (const r of universe) {
      const p = profileByTicker.get(r.ticker);
      if (p) {
        r.cik = p.cik ?? r.cik;
        r.currency = p.currency ?? r.currency;
        r.identifiers = { ...r.identifiers, ...p.identifiers };
        if (p.sector) r.sector = p.sector;
        if (p.subsector) r.subsector = p.subsector;
        enriched++;
      }
    }
    for (const f of profFailures) failures.push(`profile ${f.item.ticker}: ${f.error}`);
  }

  const now = new Date();
  let upserted = 0;
  for (const r of universe) {
    try {
      await prisma.revisionReference.upsert({
        where: { ticker: r.ticker },
        create: {
          ticker: r.ticker,
          companyName: r.companyName,
          cik: r.cik,
          sector: r.sector,
          subsector: r.subsector,
          exchange: r.exchange,
          country: r.country,
          currency: r.currency,
          marketCap: r.marketCap ?? undefined,
          identifiersJson: r.identifiers,
          isActive: true,
          lastSeenAt: now,
        },
        update: {
          companyName: r.companyName,
          cik: r.cik ?? undefined,
          sector: r.sector ?? undefined,
          subsector: r.subsector ?? undefined,
          exchange: r.exchange ?? undefined,
          country: r.country ?? undefined,
          currency: r.currency ?? undefined,
          marketCap: r.marketCap ?? undefined,
          identifiersJson: r.identifiers,
          isActive: true,
          lastSeenAt: now,
        },
      });
      upserted++;
    } catch (e) {
      failures.push(`upsert ${r.ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  log(`[reference] upserted ${upserted}/${universe.length} (enriched ${enriched})`);
  return { fetched: universe.length, upserted, enriched, failures };
}

// ─── Market-map-sourced reference ──────────────────────────────────────────
// Alternative to the FMP screener: build the revision universe from the user's
// saved market-map universe (Universe / UniverseConstituent / Security) so the
// Master Rank covers exactly the tickers they manage. FMP still supplies the
// revision DATA (Leg A/B, earnings) downstream — only the ticker list changes.

/** Input shape for the pure constituent -> reference mapping (DB-free). */
export interface MarketMapConstituentInput {
  ticker: string;
  companyName: string;
  /** User's sector taxonomy (UniverseConstituent.sector). */
  sector: string | null;
  /** User's sub-theme taxonomy (UniverseConstituent.subTheme) — the default
   *  peer-group key for z-scoring (falls back to sector under MIN_PEERS). */
  subTheme: string | null;
  country: string | null;
  currency: string | null;
  marketCap: number | null;
}

/** Pure map of a market-map constituent to the normalized reference shape. */
export function marketMapConstituentToReference(
  c: MarketMapConstituentInput,
): NormalizedReference {
  return {
    ticker: c.ticker.trim().toUpperCase(),
    companyName: c.companyName,
    cik: null,
    sector: c.sector && c.sector.trim() ? c.sector : null,
    subsector: c.subTheme && c.subTheme.trim() ? c.subTheme : null,
    exchange: null,
    country: c.country,
    currency: c.currency,
    marketCap: c.marketCap,
    identifiers: {},
  };
}

// ─── Held-position union ────────────────────────────────────────────────────
// Policy (2026-07): current portfolio holdings are ALWAYS revision-universe
// members (universe = curated market map ∪ held tickers), so every held name
// carries a research signal + next-earnings date. The weekly reference rebuild
// unions them below; the daily runner onboards newly-held names between weekly
// runs (revision-daily-events.service).

export interface HeldReferenceSummary {
  /** Tickers that now have an ACTIVE reference row (created + reactivated + already active). */
  ensured: string[];
  /** Subset that had no reference row before (brand-new onboards). */
  created: string[];
  failures: string[];
}

/**
 * Ensure every given held ticker has an ACTIVE RevisionReference row. Existing
 * rows are reactivated in place (their richer taxonomy is preserved — no
 * re-fetch); missing rows are created from the FMP profile (sector + industry,
 * parity with the screener path), falling back to the Security profile /
 * per-position sector override when the profile is unavailable. Never throws —
 * failures are collected per ticker.
 */
export async function ensureHeldReferences(
  tickers: string[],
  opts: { log?: (msg: string) => void } = {},
): Promise<HeldReferenceSummary> {
  const log = opts.log ?? (() => {});
  const failures: string[] = [];
  if (tickers.length === 0) return { ensured: [], created: [], failures };

  const now = new Date();
  const existing = await prisma.revisionReference.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true },
  });
  const existingTickers = new Set(existing.map((r) => r.ticker));
  const toCreate = tickers.filter((t) => !existingTickers.has(t));

  // Reactivate + touch existing rows (covers inactive ones deactivated by a
  // past reconcile; a no-op flag-wise for already-active rows).
  if (existingTickers.size > 0) {
    await prisma.revisionReference.updateMany({
      where: { ticker: { in: [...existingTickers] } },
      data: { isActive: true, lastSeenAt: now },
    });
  }

  const created: string[] = [];
  if (toCreate.length > 0) {
    // Fallback taxonomy: Security profile + any per-position sector override.
    const secRows = await prisma.security.findMany({
      where: { ticker: { in: toCreate } },
      select: {
        ticker: true,
        name: true,
        sector: true,
        country: true,
        currency: true,
        portfolioPositions: {
          where: { sector: { not: null } },
          select: { sector: true },
          take: 1,
        },
      },
    });
    const secByTicker = new Map(secRows.map((s) => [s.ticker, s]));

    const { results, failures: profFailures } = await fmpPool(
      toCreate,
      async (t) => ({ ticker: t, profile: await fetchProfile(t) }),
      { concurrency: 4 },
    );
    for (const f of profFailures) failures.push(`held profile ${f.item}: ${f.error}`);
    const profileByTicker = new Map(results.map((x) => [x.value.ticker, x.value.profile]));

    for (const t of toCreate) {
      const sec = secByTicker.get(t);
      const fallbackSector = sec?.sector ?? sec?.portfolioPositions[0]?.sector ?? null;
      const p = profileByTicker.get(t);
      const r: NormalizedReference = p ?? {
        ticker: t,
        companyName: sec?.name ?? t,
        cik: null,
        sector: fallbackSector,
        subsector: null,
        exchange: null,
        country: sec?.country ?? null,
        currency: sec?.currency ?? null,
        marketCap: null,
        identifiers: {},
      };
      if (!r.sector) r.sector = fallbackSector;
      try {
        await prisma.revisionReference.upsert({
          where: { ticker: t },
          create: {
            ticker: t,
            companyName: r.companyName,
            cik: r.cik,
            sector: r.sector,
            subsector: r.subsector,
            exchange: r.exchange,
            country: r.country,
            currency: r.currency,
            marketCap: r.marketCap ?? undefined,
            identifiersJson: r.identifiers,
            isActive: true,
            lastSeenAt: now,
          },
          update: { isActive: true, lastSeenAt: now },
        });
        created.push(t);
      } catch (e) {
        failures.push(`held upsert ${t}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    log(`[reference] held onboard: created ${created.length}/${toCreate.length} new reference row(s)`);
  }

  const failedCreates = new Set(toCreate.filter((t) => !created.includes(t)));
  return {
    ensured: tickers.filter((t) => !failedCreates.has(t)),
    created,
    failures,
  };
}

export interface MarketMapReferenceOptions {
  /** Specific universe to source from; defaults to the single active universe. */
  universeId?: string;
  log?: (msg: string) => void;
}

/**
 * Build RevisionReference from the active market-map universe. Upserts one row
 * per active constituent (mapping sub-theme -> subsector), unions in currently
 * held portfolio tickers (holdings are always universe members — see the
 * held-position union section above), then deactivates any existing reference
 * whose ticker is neither in the market map nor held so removed /
 * screener-only names drop out of the research queue.
 */
export async function buildReferenceFromMarketMap(
  opts: MarketMapReferenceOptions = {},
): Promise<ReferenceRefreshSummary> {
  const log = opts.log ?? (() => {});
  const failures: string[] = [];

  const universeId =
    opts.universeId ?? (await getOrCreateDefaultUniverse(prisma)).id;

  const constituents = await prisma.universeConstituent.findMany({
    where: { universeId, security: { isActive: true } },
    include: {
      security: {
        select: { ticker: true, name: true, country: true, currency: true },
      },
    },
  });
  log(`[reference] market-map universe: ${constituents.length} active constituents`);

  // Latest known market cap per security (optional; only used for ordering).
  const securityIds = constituents.map((c) => c.securityId);
  const marketCapBySecurity = new Map<string, number>();
  if (securityIds.length > 0) {
    const fundamentals = await prisma.securityFundamentals.findMany({
      where: { securityId: { in: securityIds }, marketCap: { not: null } },
      orderBy: { asOfDate: "desc" },
      select: { securityId: true, marketCap: true },
    });
    for (const f of fundamentals) {
      if (!marketCapBySecurity.has(f.securityId) && f.marketCap != null) {
        marketCapBySecurity.set(f.securityId, Number(f.marketCap));
      }
    }
  }

  const refs = constituents.map((c) =>
    marketMapConstituentToReference({
      ticker: c.security.ticker,
      companyName: c.security.name,
      sector: c.sector,
      subTheme: c.subTheme,
      country: c.security.country,
      currency: c.security.currency,
      marketCap: marketCapBySecurity.get(c.securityId) ?? null,
    }),
  );
  // De-dupe by ticker (a ticker should appear once per universe, but guard).
  const byTicker = new Map<string, NormalizedReference>();
  for (const r of refs) {
    if (r.ticker) byTicker.set(r.ticker, r);
  }
  const universe = [...byTicker.values()];

  const now = new Date();
  let upserted = 0;
  for (const r of universe) {
    try {
      await prisma.revisionReference.upsert({
        where: { ticker: r.ticker },
        create: {
          ticker: r.ticker,
          companyName: r.companyName,
          sector: r.sector,
          subsector: r.subsector,
          country: r.country,
          currency: r.currency,
          marketCap: r.marketCap ?? undefined,
          identifiersJson: r.identifiers,
          isActive: true,
          lastSeenAt: now,
        },
        update: {
          companyName: r.companyName,
          sector: r.sector ?? undefined,
          subsector: r.subsector ?? undefined,
          country: r.country ?? undefined,
          currency: r.currency ?? undefined,
          marketCap: r.marketCap ?? undefined,
          isActive: true,
          lastSeenAt: now,
        },
      });
      upserted++;
    } catch (e) {
      failures.push(`upsert ${r.ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Held-position union: portfolio holdings outside the curated map are
  // ensured as active references (existing rows keep their taxonomy; new ones
  // are onboarded from the FMP profile). Best-effort — a failure here must not
  // block the curated rebuild.
  let heldEnsured: string[] = [];
  try {
    const held = await loadAllHeldTickers();
    const heldOutside = held.filter((t) => !byTicker.has(t));
    if (heldOutside.length > 0) {
      const h = await ensureHeldReferences(heldOutside, { log });
      heldEnsured = h.ensured;
      failures.push(...h.failures.slice(0, 10));
    }
  } catch (e) {
    failures.push(`held-union: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Reconcile: deactivate references neither in the market-map universe nor
  // held so stale / screener-only names stop appearing in the ranked queue.
  // Skipped on an empty universe so a transient empty read can't wipe the
  // whole reference.
  let deactivatedCount = 0;
  if (universe.length > 0) {
    const activeTickers = [...universe.map((r) => r.ticker), ...heldEnsured];
    const deactivated = await prisma.revisionReference.updateMany({
      where: { isActive: true, ticker: { notIn: activeTickers } },
      data: { isActive: false },
    });
    deactivatedCount = deactivated.count;
  }

  log(
    `[reference] market-map upserted ${upserted}/${universe.length}; deactivated ${deactivatedCount} stale`,
  );
  return { fetched: universe.length, upserted, enriched: 0, failures };
}

/** Active universe tickers (uppercased), market-cap descending. */
export async function loadActiveUniverseTickers(): Promise<string[]> {
  const rows = await prisma.revisionReference.findMany({
    where: { isActive: true },
    select: { ticker: true },
    orderBy: { marketCap: "desc" },
  });
  return rows.map((r) => r.ticker);
}
