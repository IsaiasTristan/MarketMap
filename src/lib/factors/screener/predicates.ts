/**
 * Row predicate filters for the per-stock screener.
 *
 * Each filter, when active, returns the first reason a row fails so the UI
 * can surface "filter X dropped this stock" in a future debug mode.
 *
 * The significance gate is NOT applied here — it's a cell-level mask handled
 * in the grid render path. See `derived.ts → sigGatePassed`.
 */
import type { FactorCode } from "@/types/factors";
import type { PerStockRow } from "@/server/services/factor-per-stock.service";
import type { FactorScreenerFilters } from "@/store/analysis";
import type { ScreenerDropReason, ScreenerFilteredRows } from "./types";

/**
 * Apply every active row predicate to `rows`, returning the surviving rows
 * and a per-ticker reason for each dropped row. Order of checks is: R² →
 * observations → magnitude floors → CI excludes 0. The first failure wins
 * for the dropped-reason map.
 */
export function applyRowFilters(
  rows: ReadonlyArray<PerStockRow>,
  filters: FactorScreenerFilters,
): ScreenerFilteredRows {
  const dropped = new Map<string, ScreenerDropReason>();
  const surviving: PerStockRow[] = [];

  for (const row of rows) {
    const reason = firstFailingPredicate(row, filters);
    if (reason !== null) {
      dropped.set(row.ticker, reason);
    } else {
      surviving.push(row);
    }
  }

  return { surviving, dropped };
}

/**
 * Returns the first failing predicate for a row, or null when the row passes
 * everything. Order is fixed so the dropped-reason map is deterministic.
 */
export function firstFailingPredicate(
  row: PerStockRow,
  filters: FactorScreenerFilters,
): ScreenerDropReason | null {
  if (
    filters.minRSquared != null &&
    Number.isFinite(filters.minRSquared) &&
    (!Number.isFinite(row.rSquared) || row.rSquared < filters.minRSquared)
  ) {
    return "minRSquared";
  }

  if (
    filters.minObservations != null &&
    Number.isFinite(filters.minObservations) &&
    row.observations < filters.minObservations
  ) {
    return "minObservations";
  }

  if (
    filters.alphaMagnitudeFloor != null &&
    Number.isFinite(filters.alphaMagnitudeFloor) &&
    Math.abs(row.alphaAnnualized) < filters.alphaMagnitudeFloor
  ) {
    return "alphaMagnitudeFloor";
  }

  for (const [code, floor] of Object.entries(filters.betaMagnitudeFloor)) {
    if (floor == null || !Number.isFinite(floor)) continue;
    const cell = row.cells[code as FactorCode];
    // No cell for this factor on this stock — treat as |β| = 0, fail floor
    // unless the floor itself is 0.
    const beta = cell ? Math.abs(cell.beta) : 0;
    if (beta < floor) return "betaMagnitudeFloor";
  }

  if (filters.alphaCiExcludesZero) {
    // CI excludes 0 ⇔ |α_annualised| > CI half-width (95 %). When CI is 0 or
    // missing we treat as not-excluding (i.e. row fails the "must exclude 0"
    // requirement). |α| / CI > 1 is equivalent to |t| > 1.96.
    const halfWidth = row.alphaCi95Half;
    const excludesZero =
      Number.isFinite(halfWidth) &&
      halfWidth > 0 &&
      Math.abs(row.alphaAnnualized) > halfWidth;
    if (!excludesZero) return "alphaCiExcludesZero";
  }

  return null;
}

/** True when at least one of the row predicates is active. */
export function hasAnyActiveRowFilter(filters: FactorScreenerFilters): boolean {
  if (filters.minRSquared != null && Number.isFinite(filters.minRSquared)) return true;
  if (filters.minObservations != null && Number.isFinite(filters.minObservations)) {
    return true;
  }
  if (
    filters.alphaMagnitudeFloor != null &&
    Number.isFinite(filters.alphaMagnitudeFloor)
  ) {
    return true;
  }
  for (const v of Object.values(filters.betaMagnitudeFloor)) {
    if (v != null && Number.isFinite(v)) return true;
  }
  if (filters.alphaCiExcludesZero) return true;
  return false;
}
