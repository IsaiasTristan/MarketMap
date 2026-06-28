import type { PrismaClient } from "@prisma/client";
import type { DateClose } from "@/domain/calculations/alignment";
import {
  computeGroupReturnCorrelations,
  type ReturnGroup,
} from "@/domain/calculations/group-correlation";
import { getOrCreateDefaultUniverse } from "@/server/services/universe.service";
import { loadRecentPricesBatch } from "@/server/services/market-map.service";

export interface CorrelationMatrixPayload {
  labels: string[];
  matrix: number[][];
  obs: number;
  asOf: string | null;
  window: number;
}

export interface MarketCorrelationsResult {
  sector: CorrelationMatrixPayload;
  subTheme: CorrelationMatrixPayload;
  warnings: string[];
}

/** Daily simple returns keyed by trade date for one security's price series. */
function dailyReturnsByDate(series: DateClose[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.adjClose;
    const cur = series[i]!.adjClose;
    if (prev > 0 && Number.isFinite(prev) && Number.isFinite(cur)) {
      out.set(series[i]!.date, cur / prev - 1);
    }
  }
  return out;
}

/**
 * Fold per-constituent return maps into equal-weight group return series.
 * For each group and date, the group return is the mean of the constituent
 * returns available on that date.
 */
function buildGroupReturns(
  members: { key: string; returns: Map<string, number> }[],
): ReturnGroup[] {
  // group key -> (date -> [sum, count])
  const acc = new Map<string, Map<string, { sum: number; count: number }>>();
  for (const m of members) {
    let byDate = acc.get(m.key);
    if (!byDate) {
      byDate = new Map();
      acc.set(m.key, byDate);
    }
    for (const [date, r] of m.returns) {
      const cell = byDate.get(date);
      if (cell) {
        cell.sum += r;
        cell.count += 1;
      } else {
        byDate.set(date, { sum: r, count: 1 });
      }
    }
  }

  const groups: ReturnGroup[] = [];
  for (const [key, byDate] of acc) {
    const returnsByDate = new Map<string, number>();
    for (const [date, { sum, count }] of byDate) {
      returnsByDate.set(date, sum / count);
    }
    groups.push({ key, returnsByDate });
  }
  // Stable, readable ordering for the heatmap axes.
  groups.sort((a, b) => a.key.localeCompare(b.key));
  return groups;
}

/**
 * Compute Sector and Sub-Theme price-performance correlation matrices for the
 * active universe over the last `window` trading days. Returns are equal-weight
 * daily simple returns aggregated across each group's active constituents.
 */
export async function getMarketCorrelations(
  db: PrismaClient,
  window: number,
): Promise<MarketCorrelationsResult> {
  const warnings: string[] = [];
  const universe = await getOrCreateDefaultUniverse(db);

  const constituents = await db.universeConstituent.findMany({
    where: { universeId: universe.id, security: { isActive: true } },
    include: { security: { select: { id: true, ticker: true } } },
  });

  const empty: CorrelationMatrixPayload = {
    labels: [],
    matrix: [],
    obs: 0,
    asOf: null,
    window,
  };

  if (constituents.length === 0) {
    warnings.push("No active constituents in this universe.");
    return { sector: empty, subTheme: { ...empty }, warnings };
  }

  const pricesBySecurity = await loadRecentPricesBatch(
    db,
    constituents.map((c) => c.securityId),
  );

  const sectorMembers: { key: string; returns: Map<string, number> }[] = [];
  const subThemeMembers: { key: string; returns: Map<string, number> }[] = [];

  for (const c of constituents) {
    const series = pricesBySecurity.get(c.securityId) ?? [];
    if (series.length < 2) continue;
    const returns = dailyReturnsByDate(series);
    if (returns.size === 0) continue;
    sectorMembers.push({ key: c.sector, returns });
    // Sub-theme axis labels carry the parent sector for disambiguation, since
    // the same sub-theme name can appear under different sectors.
    subThemeMembers.push({ key: `${c.sector} / ${c.subTheme}`, returns });
  }

  const sectorGroups = buildGroupReturns(sectorMembers);
  const subThemeGroups = buildGroupReturns(subThemeMembers);

  const sectorCorr = computeGroupReturnCorrelations(sectorGroups, window);
  const subThemeCorr = computeGroupReturnCorrelations(subThemeGroups, window);

  return {
    sector: { ...sectorCorr, window },
    subTheme: { ...subThemeCorr, window },
    warnings,
  };
}
