/**
 * Shared "Bloomberg" grid styling — the look-and-feel adopted from the market
 * map heatmap (see `MarketMapClient.tsx` lines 800-810 for the original
 * pickTextColor; lines 894-912 for header/cell measurements). All grid /
 * heatmap surfaces in `src/components/analysis/` should consume these
 * constants so headers, fonts, and heat-cell text contrast stay consistent.
 */

export const BB_GRID_FONT_STACK =
  'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace';

/** Body & heat-cell font size (px). */
export const BB_GRID_FONT_SIZE = 12;
/** Header font size (px). */
export const BB_GRID_HEADER_FONT_SIZE = 12;

/** Header chrome — black surface to match the market-map look. */
export const BB_GRID_HEADER_BG = "var(--bg-surface)";
export const BB_GRID_HEADER_COLOR = "var(--text-primary)";
export const BB_GRID_HEADER_FONT_WEIGHT = 700;
export const BB_GRID_HEADER_LETTER_SPACING = "0.06em";

/** Standard 1px border between cells. */
export const BB_GRID_BORDER = "1px solid var(--bg-border)";

/** Graduated row backgrounds by hierarchy level (matches MarketMapClient). */
export const BB_ROW_BG = {
  sector: "#0a0a0a",
  subtheme: "#080808",
  company: "#050505",
  default: "var(--bg-surface)",
} as const;

/**
 * Pick black or white text based on YIQ luminance of the background colour.
 * Mirrors `pickTextColor` in `MarketMapClient.tsx`. Pass an `rgb(r, g, b)`
 * string (the format produced by `heatSignedBloomberg` / `heatmapRgb`).
 * Falls back to white for transparent / unparseable backgrounds.
 */
export function pickTextColor(bg: string): "#000000" | "#ffffff" {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(bg);
  if (!m) return "#ffffff";
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#000000" : "#ffffff";
}

/**
 * Density preset for table cells. `data` is the default for numeric grids;
 * `sector` / `subtheme` / `company` apply the market-map row hierarchy.
 */
export function getCellDensity(
  level: "sector" | "subtheme" | "company" | "data",
): { padding: string; fontSize: number; fontWeight: number } {
  switch (level) {
    case "sector":
      return { padding: "0 6px", fontSize: BB_GRID_FONT_SIZE, fontWeight: 700 };
    case "subtheme":
      return { padding: "0 6px", fontSize: BB_GRID_FONT_SIZE, fontWeight: 500 };
    case "company":
      return { padding: "0 6px", fontSize: BB_GRID_FONT_SIZE, fontWeight: 500 };
    case "data":
    default:
      return { padding: "0 6px", fontSize: BB_GRID_FONT_SIZE, fontWeight: 500 };
  }
}

/** Inline base style spread for any grid header `<th>`. */
export const BB_HEADER_BASE_STYLE: React.CSSProperties = {
  background: BB_GRID_HEADER_BG,
  color: BB_GRID_HEADER_COLOR,
  fontSize: BB_GRID_HEADER_FONT_SIZE,
  fontWeight: BB_GRID_HEADER_FONT_WEIGHT,
  letterSpacing: BB_GRID_HEADER_LETTER_SPACING,
  textTransform: "uppercase",
  fontFamily: BB_GRID_FONT_STACK,
  borderBottom: BB_GRID_BORDER,
  whiteSpace: "nowrap",
};
