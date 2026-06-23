/**
 * Shared deterministic sector / sub-theme color utility.
 *
 * Sectors and sub-themes are user-defined CSV values (not a fixed enum), so
 * "consistent" color coding means a stable name-based mapping: the same
 * sector name always renders in the same base color, and every sub-theme
 * renders as a distinct LIGHTER shade of its parent sector's base color.
 *
 * Palette mirrors the high-contrast set already used in the factor scatter
 * panel so unrelated surfaces visually agree.
 */

export const SECTOR_PALETTE: readonly string[] = [
  "#5fb3d9",
  "#d97a5f",
  "#7ad95f",
  "#d95fb3",
  "#5fd9b3",
  "#d9b35f",
  "#b35fd9",
  "#5f7ad9",
  "#d95f5f",
  "#5fd97a",
];

const FALLBACK_COLOR = "#a5a5a5";

/**
 * Sub-theme lightness band (HSL L%, applied on top of the parent sector
 * hue/sat). The min sits strictly above every palette base color's
 * lightness (~61%) so a sub-theme always reads as a LIGHTER shade of its
 * sector, and the spread is wide enough that distinct sub-themes within
 * one sector are visually distinguishable.
 */
const SUB_THEME_L_MIN = 72;
const SUB_THEME_L_MAX = 90;

/**
 * djb2-style string hash. Stable across runs / platforms; trims + lowercases
 * the input so casing / surrounding whitespace from CSV imports doesn't
 * silently fork the same name into two colors.
 */
export function hashString(input: string): number {
  const key = input.trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < key.length; i += 1) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  return h;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function hexToHsl(hex: string): Hsl {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { h: 0, s: 0, l: 50 };
  const int = parseInt(m[1]!, 16);
  const r = ((int >> 16) & 0xff) / 255;
  const g = ((int >> 8) & 0xff) / 255;
  const b = (int & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const sN = Math.max(0, Math.min(100, s)) / 100;
  const lN = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = lN - c / 2;
  const to = (v: number) => {
    const n = Math.round((v + m) * 255);
    return n.toString(16).padStart(2, "0");
  };
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}

/**
 * Deterministic sector color. Falls back to a neutral gray for empty input
 * so callers don't need to guard `?? "Unknown"` themselves.
 */
export function sectorColor(sector: string | null | undefined): string {
  if (!sector || sector.trim() === "") return FALLBACK_COLOR;
  const idx = hashString(sector) % SECTOR_PALETTE.length;
  return SECTOR_PALETTE[idx]!;
}

/**
 * Deterministic sub-theme color: same hue/saturation as the parent sector
 * but a hash-driven lightness in [SUB_THEME_L_MIN, SUB_THEME_L_MAX]. The
 * band sits strictly above any palette base color's lightness so a
 * sub-theme always reads as a lighter shade of its sector, and distinct
 * sub-themes within one sector get distinct shades.
 */
export function subThemeColor(
  sector: string | null | undefined,
  subTheme: string | null | undefined,
): string {
  if (!subTheme || subTheme.trim() === "") return FALLBACK_COLOR;
  const base = sectorColor(sector);
  const { h, s } = hexToHsl(base);
  const span = SUB_THEME_L_MAX - SUB_THEME_L_MIN;
  const l = SUB_THEME_L_MIN + (hashString(subTheme) % (span + 1));
  return hslToHex({ h, s, l });
}
