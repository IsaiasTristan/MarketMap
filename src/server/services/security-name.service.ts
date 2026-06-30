import type { PrismaClient } from "@prisma/client";
import { fetchProfile, fmpPool } from "@/infrastructure/providers/fmp";
import { fetchYahooDisplayName } from "@/infrastructure/providers/yahoo-quote-http";
import { invalidateMarketMapCache } from "./market-map-cache.service";

/**
 * A "missing" display name is one that is still equal to the ticker symbol —
 * the parser / add path defaults `Security.name` to the ticker when no name is
 * supplied. This is also what makes user edits final: once a real name is set
 * it no longer equals the ticker, so it is never treated as missing again.
 */
export function nameIsMissing(name: string, ticker: string): boolean {
  return name.trim().toUpperCase() === ticker.trim().toUpperCase();
}

/**
 * Resolve a real company display name for a ticker. Tries FMP first (reliable
 * "Ultimate-class" key, returns `companyName`) and falls back to Yahoo. Returns
 * null when neither yields a name that differs from the ticker itself.
 */
export async function resolveCompanyName(ticker: string): Promise<string | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return null;

  try {
    const profile = await fetchProfile(symbol);
    const fmpName = profile?.companyName?.trim();
    if (fmpName && !nameIsMissing(fmpName, symbol)) return fmpName;
  } catch {
    // Fall through to Yahoo on any FMP error.
  }

  try {
    const yahooName = (await fetchYahooDisplayName(symbol)).trim();
    if (yahooName && !nameIsMissing(yahooName, symbol)) return yahooName;
  } catch {
    // Best-effort; leave the ticker as-is below.
  }

  return null;
}

/**
 * Load `Security.name` keyed by uppercased ticker — the single source of truth
 * for company display names (what the market map renders and what the Data tab
 * edits). `Security.ticker` is globally unique, so this is universe-agnostic.
 * Pass `tickers` to scope the read; omit it to load every security.
 */
export async function getCompanyNamesByTicker(
  db: PrismaClient,
  tickers?: string[]
): Promise<Map<string, string>> {
  const where =
    tickers && tickers.length > 0
      ? { ticker: { in: tickers.map((t) => t.trim().toUpperCase()) } }
      : {};
  const securities = await db.security.findMany({
    where,
    select: { ticker: true, name: true },
  });
  const map = new Map<string, string>();
  for (const s of securities) {
    map.set(s.ticker.trim().toUpperCase(), s.name);
  }
  return map;
}

/**
 * Resolve the display name for a ticker against the {@link getCompanyNamesByTicker}
 * map. The market-map source wins whenever the ticker is in the universe; for a
 * ticker outside it (rare on engine surfaces), fall back to the snapshot's baked
 * name and finally the ticker itself. Pure — safe to unit-test.
 */
export function pickDisplayName(
  namesByTicker: Map<string, string>,
  ticker: string,
  baked?: string | null
): string {
  const t = ticker.trim().toUpperCase();
  const fromSource = namesByTicker.get(t);
  if (fromSource != null) return fromSource;
  if (baked != null && baked.trim() !== "") return baked;
  return t;
}

export type BackfillNamesResult = {
  scanned: number;
  filled: number;
  remaining: number;
  failures: { ticker: string; error: string }[];
};

/**
 * Backfill company names for every active constituent of `universeId` whose
 * `Security.name` still equals its ticker. Resolved names are written straight
 * to `Security.name` (write-once: rows whose name already differs from the
 * ticker are never touched), so the result persists and is not re-pulled on a
 * later run. Idempotent — once a name resolves it no longer matches the
 * missing-name filter.
 */
export async function backfillUniverseConstituentNames(
  db: PrismaClient,
  universeId: string
): Promise<BackfillNamesResult> {
  const constituents = await db.universeConstituent.findMany({
    where: { universeId, security: { isActive: true } },
    select: { security: { select: { id: true, ticker: true, name: true } } },
  });

  const missing = constituents
    .map((c) => c.security)
    .filter((s) => nameIsMissing(s.name, s.ticker));

  if (missing.length === 0) {
    return { scanned: 0, filled: 0, remaining: 0, failures: [] };
  }

  const { results, failures } = await fmpPool(
    missing,
    async (s) => ({ id: s.id, name: await resolveCompanyName(s.ticker) }),
    { concurrency: 8 }
  );

  let filled = 0;
  for (const { value } of results) {
    if (!value.name) continue;
    await db.security.update({
      where: { id: value.id },
      data: { name: value.name },
    });
    filled += 1;
  }

  if (filled > 0) {
    await invalidateMarketMapCache(universeId);
  }

  return {
    scanned: missing.length,
    filled,
    remaining: missing.length - filled,
    failures: failures.map((f) => ({ ticker: f.item.ticker, error: f.error })),
  };
}
