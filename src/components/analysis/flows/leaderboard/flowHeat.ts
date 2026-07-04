/**
 * Flow Leaderboard — diverging blue/red heat scale.
 *
 * The spec reserves a distinct diverging palette for the leaderboard's flow
 * cells: blue #2a78d6 (accumulation) ↔ neutral ↔ red #e34948 (distribution).
 * This is DELIBERATELY separate from the shared red/gray/green heatmap.ts so the
 * blue/red hues only ever mean "capital flow" on this page. Returns an `rgb(...)`
 * string so it pairs with pickTextColor() from bloomberg-grid.ts for contrast.
 */

const BLUE = { r: 0x2a, g: 0x78, b: 0xd6 }; // #2a78d6 — net accumulation
const RED = { r: 0xe3, g: 0x49, b: 0x48 }; // #e34948 — net distribution
// Theme-neutral mid: a muted slate that reads on both light and dark surfaces.
const NEUTRAL = { r: 0x8a, g: 0x90, b: 0x99 };

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);

/**
 * Diverging fill for a signed flow `value`, scaled so that |value| ≥ `span`
 * saturates. Positive → blue, negative → red, near-zero → neutral. `span`
 * defaults to 25 (the spec's netflow scale, |25|).
 */
export function flowHeatColor(value: number, span = 25): string {
  if (!Number.isFinite(value) || value === 0) return `rgb(${NEUTRAL.r}, ${NEUTRAL.g}, ${NEUTRAL.b})`;
  const t = clamp01(Math.abs(value) / span);
  const end = value > 0 ? BLUE : RED;
  return `rgb(${lerp(NEUTRAL.r, end.r, t)}, ${lerp(NEUTRAL.g, end.g, t)}, ${lerp(NEUTRAL.b, end.b, t)})`;
}

/** Solid endpoint colors, e.g. for the score bar and legend. */
export const FLOW_BLUE = `rgb(${BLUE.r}, ${BLUE.g}, ${BLUE.b})`;
export const FLOW_RED = `rgb(${RED.r}, ${RED.g}, ${RED.b})`;
