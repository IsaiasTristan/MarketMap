/**
 * Engine 1 — pure presentation helpers shared by the research screens and the
 * queue's server-side filters. Kept out of the component tree so the tint
 * ramp, the cap formatter and the engine-tag sign convention are unit-testable
 * and have exactly one definition.
 */

/** Neutral surface the breadth ramp starts from. */
const NEUTRAL_RGB = [31, 31, 35] as const;
const GREEN_RGB = [47, 143, 69] as const;
const RED_RGB = [168, 58, 63] as const;

/**
 * Industry-breadth cell fill: red at z = −1, neutral at 0, green at +1.
 * Clamped, because one runaway industry should not wash out the rest of the grid.
 */
export function breadthTint(z: number | null | undefined): string {
  const rgb =
    z === null || z === undefined || !Number.isFinite(z)
      ? NEUTRAL_RGB
      : mix(Math.max(-1, Math.min(1, z)));
  return `rgb(${rgb.join(",")})`;
}

function mix(t: number): number[] {
  const to = t >= 0 ? GREEN_RGB : RED_RGB;
  const k = Math.abs(t);
  return NEUTRAL_RGB.map((c, i) => Math.round(c + (to[i]! - c) * k));
}

/** "$1.4B" / "$820M"; em dash when there is no cap on file. */
export function fmtCap(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${Math.round(v)}`;
}

/** Signed percent; "n/m" when the base made the ratio meaningless. */
export function fmtPctOrNm(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return "n/m";
  if (!Number.isFinite(v)) return "n/m";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}

/**
 * Bullish / bearish reading of an Engine 2/3/4 tag; null = the tag makes no
 * directional claim. Used by the queue's "two engines agree" filter and by the
 * tag chips, so both read the same convention.
 */
export function engineTagSign(tag: string | null | undefined): 1 | -1 | null {
  switch (tag) {
    case "INFLECT":
    case "QUAL":
    case "ACCUM":
    case "MOM+":
    case "VAL":
      return 1;
    case "TRAP":
    case "DISTRIB":
    case "CROWDED":
      return -1;
    default:
      return null;
  }
}

/** True when at least two engines make a directional claim and they agree. */
export function enginesAgree(tags: Array<string | null>): boolean {
  const signs = tags.map(engineTagSign).filter((s): s is 1 | -1 => s !== null);
  return signs.length >= 2 && signs.every((s) => s === signs[0]);
}
