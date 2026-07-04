/**
 * Region-inspector row derivation for the crowding × conviction scatter (Part 2).
 *
 * Given a set of selected tickers, resolve them to full data rows FROM THE MODEL
 * (never from pixels), so a selection survives zoom/pan unchanged. Pure — no
 * React/DOM.
 */
import type { QuadrantModel, PlottedPoint } from "./quadrantModel";
import { isBelowRange } from "./gutter";
import { classifyZone, type Zone } from "./zones";

export type RowLayer = "foreground" | "context" | "below range";

export interface InspectorRow {
  ticker: string;
  companyName: string | null;
  breadth: number;
  conviction: number | null;
  deltaHolders: number;
  holderStreak: number;
  quadrant: string | null;
  trajectoryLabel: string | null;
  danger: boolean;
  layer: RowLayer;
  zone: Zone;
}

/**
 * Resolve a ticker set to inspector rows, sorted by conviction descending
 * (null conviction sorts last), ticker as a stable tiebreak. Below-range names
 * (gutter) are tagged "below range"; other names carry their model layer.
 * Tickers absent from the model are ignored.
 */
export function deriveInspectorRows(
  tickers: Iterable<string>,
  model: QuadrantModel,
  gutterFloorPct: number,
): InspectorRow[] {
  const byTicker = new Map<string, { p: PlottedPoint; layer: "foreground" | "background" }>();
  for (const p of model.foreground) byTicker.set(p.ticker, { p, layer: "foreground" });
  for (const p of model.background) byTicker.set(p.ticker, { p, layer: "background" });

  const rows: InspectorRow[] = [];
  for (const t of tickers) {
    const hit = byTicker.get(t);
    if (!hit) continue;
    const { p, layer } = hit;
    const below = isBelowRange(p.conviction, gutterFloorPct);
    rows.push({
      ticker: p.ticker,
      companyName: p.companyName,
      breadth: p.breadth,
      conviction: p.conviction,
      deltaHolders: p.deltaHolders,
      holderStreak: p.holderStreak,
      quadrant: p.quadrant,
      trajectoryLabel: p.trajectoryLabel,
      danger: p.danger,
      layer: below ? "below range" : layer === "foreground" ? "foreground" : "context",
      zone: classifyZone(p.breadth, p.conviction, model.p75Breadth, model.p75Conviction),
    });
  }

  rows.sort((a, b) => {
    const ca = a.conviction ?? -Infinity;
    const cb = b.conviction ?? -Infinity;
    if (cb !== ca) return cb - ca;
    return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
  });
  return rows;
}

/** Aggregate net flow of a selection — sum of Δholders (net holder change). */
export function aggregateNetFlow(rows: InspectorRow[]): number {
  return rows.reduce((s, r) => s + r.deltaHolders, 0);
}
