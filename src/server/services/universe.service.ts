import type { PrismaClient } from "@prisma/client";
import type { ParsedUniverseRow } from "@/domain/universe/parse";

const DEFAULT_UNIVERSE_NAME = "Universe";

export async function createUniverse(
  db: PrismaClient,
  name: string
): Promise<{ id: string }> {
  const u = await db.universe.create({ data: { name } });
  return { id: u.id };
}

/**
 * App operates as a single-universe screener. Return the existing (most
 * recently updated) universe or create the default one if none exists.
 */
export async function getOrCreateDefaultUniverse(
  db: PrismaClient
): Promise<{ id: string; name: string; constituentCount: number }> {
  const existing = await db.universe.findFirst({
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { constituents: true } } },
  });
  if (existing) {
    return {
      id: existing.id,
      name: existing.name,
      constituentCount: existing._count.constituents,
    };
  }
  const created = await db.universe.create({
    data: { name: DEFAULT_UNIVERSE_NAME },
  });
  return { id: created.id, name: created.name, constituentCount: 0 };
}

/**
 * Remove a single ticker from a universe. Returns true if a row was
 * removed; false when the ticker was not part of the universe. The
 * underlying Security row is left in place — it may still be referenced
 * by portfolios, factor snapshots or price history.
 */
export async function removeUniverseConstituent(
  db: PrismaClient,
  universeId: string,
  ticker: string
): Promise<boolean> {
  const normalized = ticker.trim().toUpperCase();
  if (!normalized) return false;
  const security = await db.security.findUnique({
    where: { ticker: normalized },
    select: { id: true },
  });
  if (!security) return false;
  const result = await db.universeConstituent.deleteMany({
    where: { universeId, securityId: security.id },
  });
  return result.count > 0;
}

export type ReplaceUniverseResult = {
  applied: number;
  created: number;
  reactivated: number;
  renamed: number;
  duplicatesDropped: number;
};

/**
 * Replace the entire constituent list of a universe with `rows`.
 *
 * Implementation note: a naive sequential upsert-per-row loop blows past
 * Prisma's default 5 s interactive-transaction timeout for large pastes
 * (~750+ tickers ≈ 1500 round-trips). We pre-resolve which securities are
 * already in the DB, then issue at most a handful of batched writes inside
 * the transaction so the apply step finishes in well under the limit even
 * for multi-thousand-row universes.
 */
export async function replaceUniverseConstituents(
  db: PrismaClient,
  universeId: string,
  rows: ParsedUniverseRow[]
): Promise<ReplaceUniverseResult> {
  // De-dupe by uppercased ticker (last-write wins for the metadata) so the
  // input never violates the @@unique([universeId, securityId]) constraint
  // when a ticker appears twice in the pasted list.
  const byTicker = new Map<string, ParsedUniverseRow>();
  for (const r of rows) {
    const ticker = r.ticker.trim().toUpperCase();
    if (!ticker) continue;
    byTicker.set(ticker, { ...r, ticker });
  }
  const ordered = [...byTicker.values()];
  const duplicatesDropped = rows.length - ordered.length;

  if (ordered.length === 0) {
    await db.universeConstituent.deleteMany({ where: { universeId } });
    return {
      applied: 0,
      created: 0,
      reactivated: 0,
      renamed: 0,
      duplicatesDropped,
    };
  }

  const tickers = ordered.map((r) => r.ticker);

  // Pre-load existing securities so we can compute create/update sets
  // outside the transaction. Keeps the write window tight.
  const existing = await db.security.findMany({
    where: { ticker: { in: tickers } },
    select: { id: true, ticker: true, name: true, isActive: true },
  });
  const existingByTicker = new Map(existing.map((s) => [s.ticker, s]));

  const toCreate: { ticker: string; name: string }[] = [];
  const toRename: { id: string; name: string }[] = [];
  const toReactivate: string[] = [];
  for (const r of ordered) {
    const e = existingByTicker.get(r.ticker);
    if (!e) {
      toCreate.push({ ticker: r.ticker, name: r.companyName });
      continue;
    }
    if (e.name !== r.companyName) {
      toRename.push({ id: e.id, name: r.companyName });
    }
    if (!e.isActive) toReactivate.push(e.ticker);
  }

  await db.$transaction(
    async (tx) => {
      await tx.universeConstituent.deleteMany({ where: { universeId } });

      if (toCreate.length > 0) {
        await tx.security.createMany({
          data: toCreate,
          skipDuplicates: true,
        });
      }

      if (toReactivate.length > 0) {
        await tx.security.updateMany({
          where: { ticker: { in: toReactivate } },
          data: { isActive: true },
        });
      }

      // Per-row name updates only for the (usually small) set whose name
      // actually changed. Done inside the transaction so the universe is
      // never observed in a half-renamed state.
      for (const u of toRename) {
        await tx.security.update({
          where: { id: u.id },
          data: { name: u.name },
        });
      }

      // Re-fetch IDs (newly-created rows now have ids).
      const allSec = await tx.security.findMany({
        where: { ticker: { in: tickers } },
        select: { id: true, ticker: true },
      });
      const idByTicker = new Map(allSec.map((s) => [s.ticker, s.id]));

      const constituentRows = ordered.flatMap((r, idx) => {
        const id = idByTicker.get(r.ticker);
        if (!id) return [];
        return [
          {
            universeId,
            securityId: id,
            sector: r.sector,
            subTheme: r.subTheme,
            sortOrder: idx,
          },
        ];
      });

      if (constituentRows.length > 0) {
        await tx.universeConstituent.createMany({
          data: constituentRows,
          skipDuplicates: true,
        });
      }
    },
    // 30 s is comfortably above the worst-case time we have measured for
    // ~1k-row pastes; the default 5 s is what was failing for large lists.
    { timeout: 30_000, maxWait: 10_000 }
  );

  return {
    applied: ordered.length,
    created: toCreate.length,
    reactivated: toReactivate.length,
    renamed: toRename.length,
    duplicatesDropped,
  };
}

export type AddUniverseResult = {
  applied: number;
  created: number;
  reactivated: number;
  renamed: number;
  updated: number;
  duplicatesDropped: number;
};

/**
 * Append `rows` to a universe WITHOUT removing existing constituents.
 *
 * Unlike `replaceUniverseConstituents`, this never deletes — it is the
 * single-ticker / handful add path. A ticker already in the universe has its
 * `sector` / `subTheme` updated in place (counted as `updated`); a ticker not
 * yet present is appended after the current max `sortOrder`. The underlying
 * Security is created / reactivated / renamed using the same rules as the
 * replace path so name and active-state stay consistent.
 */
export async function addUniverseConstituents(
  db: PrismaClient,
  universeId: string,
  rows: ParsedUniverseRow[]
): Promise<AddUniverseResult> {
  // De-dupe by uppercased ticker (last-write wins for metadata) so a repeated
  // ticker in the same payload never violates the unique constraint.
  const byTicker = new Map<string, ParsedUniverseRow>();
  for (const r of rows) {
    const ticker = r.ticker.trim().toUpperCase();
    if (!ticker) continue;
    byTicker.set(ticker, { ...r, ticker });
  }
  const ordered = [...byTicker.values()];
  const duplicatesDropped = rows.length - ordered.length;

  if (ordered.length === 0) {
    return {
      applied: 0,
      created: 0,
      reactivated: 0,
      renamed: 0,
      updated: 0,
      duplicatesDropped,
    };
  }

  const tickers = ordered.map((r) => r.ticker);

  const existing = await db.security.findMany({
    where: { ticker: { in: tickers } },
    select: { id: true, ticker: true, name: true, isActive: true },
  });
  const existingByTicker = new Map(existing.map((s) => [s.ticker, s]));

  const toCreate: { ticker: string; name: string }[] = [];
  const toRename: { id: string; name: string }[] = [];
  const toReactivate: string[] = [];
  for (const r of ordered) {
    const e = existingByTicker.get(r.ticker);
    if (!e) {
      toCreate.push({ ticker: r.ticker, name: r.companyName });
      continue;
    }
    if (e.name !== r.companyName) {
      toRename.push({ id: e.id, name: r.companyName });
    }
    if (!e.isActive) toReactivate.push(e.ticker);
  }

  // Which securities are ALREADY constituents of this universe — drives the
  // update-vs-append decision deterministically (a new security can never be
  // an existing constituent, so we only need to check the ones that exist).
  const existingSecurityIds = existing.map((s) => s.id);
  const existingConstituents =
    existingSecurityIds.length > 0
      ? await db.universeConstituent.findMany({
          where: { universeId, securityId: { in: existingSecurityIds } },
          select: { securityId: true },
        })
      : [];
  const alreadyMember = new Set(existingConstituents.map((c) => c.securityId));

  // Append after the existing tail so added rows sort below current members.
  const maxOrder = await db.universeConstituent.aggregate({
    where: { universeId },
    _max: { sortOrder: true },
  });
  let nextOrder = (maxOrder._max.sortOrder ?? -1) + 1;

  let updated = 0;
  await db.$transaction(
    async (tx) => {
      if (toCreate.length > 0) {
        await tx.security.createMany({ data: toCreate, skipDuplicates: true });
      }
      if (toReactivate.length > 0) {
        await tx.security.updateMany({
          where: { ticker: { in: toReactivate } },
          data: { isActive: true },
        });
      }
      for (const u of toRename) {
        await tx.security.update({ where: { id: u.id }, data: { name: u.name } });
      }

      const allSec = await tx.security.findMany({
        where: { ticker: { in: tickers } },
        select: { id: true, ticker: true },
      });
      const idByTicker = new Map(allSec.map((s) => [s.ticker, s.id]));

      for (const r of ordered) {
        const securityId = idByTicker.get(r.ticker);
        if (!securityId) continue;
        if (alreadyMember.has(securityId)) {
          await tx.universeConstituent.update({
            where: { universeId_securityId: { universeId, securityId } },
            data: { sector: r.sector, subTheme: r.subTheme },
          });
          updated += 1;
        } else {
          await tx.universeConstituent.create({
            data: {
              universeId,
              securityId,
              sector: r.sector,
              subTheme: r.subTheme,
              sortOrder: nextOrder,
            },
          });
          nextOrder += 1;
        }
      }
    },
    { timeout: 30_000, maxWait: 10_000 }
  );

  return {
    applied: ordered.length,
    created: toCreate.length,
    reactivated: toReactivate.length,
    renamed: toRename.length,
    updated,
    duplicatesDropped,
  };
}
