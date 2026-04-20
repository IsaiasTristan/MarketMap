/**
 * Driver aggregation: roll up per-position factor loadings to
 * sector, sub-theme, or position level and identify top contributors.
 */
import type {
  FactorCode,
  PositionLoadings,
  FactorDriversEntry,
  FactorDriverEntry,
  DriversResult,
} from "@/types/factors";
import { getFactorDef } from "../definitions/factor-codes";

type GroupBy = "position" | "sector" | "subTheme";

/** Herfindahl-Hirschman Index on the absolute contributions. */
function hhi(contributions: number[]): number {
  const totalAbs = contributions.reduce((s, c) => s + Math.abs(c), 0);
  if (totalAbs === 0) return 0;
  return contributions.reduce((s, c) => s + (Math.abs(c) / totalAbs) ** 2, 0);
}

/**
 * Aggregate per-position loadings by group and build top-N contributor lists.
 *
 * @param positions   Per-position factor loadings (from computeHoldingsLoadings).
 * @param factorCodes Factors present in loadings.
 * @param groupBy     Aggregation level.
 * @param topN        How many top/bottom contributors to return per factor.
 */
export function computeDrivers(
  positions: PositionLoadings[],
  factorCodes: FactorCode[],
  groupBy: GroupBy = "position",
  topN = 5,
): DriversResult {
  // Group positions
  const groups = new Map<string, { label: string; items: PositionLoadings[] }>();
  for (const pos of positions) {
    const key =
      groupBy === "sector"
        ? pos.sector
        : groupBy === "subTheme"
          ? pos.subTheme
          : pos.ticker;
    if (!groups.has(key)) {
      groups.set(key, { label: key, items: [] });
    }
    groups.get(key)!.items.push(pos);
  }

  // For each group, compute weight-averaged loading per factor
  const groupEntries = Array.from(groups.entries()).map(([key, { label, items }]) => {
    const totalWeight = items.reduce((s, p) => s + p.weight, 0);
    const weight = totalWeight;
    const loadings: Partial<Record<FactorCode, number>> = {};
    for (const code of factorCodes) {
      if (totalWeight === 0) {
        loadings[code] = 0;
      } else {
        loadings[code] = items.reduce(
          (s, p) => s + p.weight * (p.loadings[code] ?? 0),
          0,
        ) / totalWeight;
      }
    }
    return { key, label, weight, loadings };
  });

  // Build per-factor driver tables
  const factors: FactorDriversEntry[] = factorCodes.map((code) => {
    const entries: FactorDriverEntry[] = groupEntries.map((g) => ({
      key: g.key,
      label: g.label,
      weight: g.weight,
      loading: g.loadings[code] ?? 0,
      contribution: g.weight * (g.loadings[code] ?? 0),
    }));

    const sorted = [...entries].sort((a, b) => b.contribution - a.contribution);
    const topPositive = sorted.filter((e) => e.contribution > 0).slice(0, topN);
    const topNegative = [...sorted].reverse().filter((e) => e.contribution < 0).slice(0, topN);
    const concentrationHHI = hhi(entries.map((e) => e.contribution));
    const portfolioExposure = entries.reduce((s, e) => s + e.contribution, 0);

    return {
      code,
      label: getFactorDef(code).label,
      portfolioExposure,
      topPositive,
      topNegative,
      concentrationHHI,
    };
  });

  return { groupBy, factors };
}
