/**
 * Shared typed contracts for the COMMODITIES tab (forward curves).
 * Mirrors src/types/factors.ts: API responses, service outputs, and
 * lib/commodities module returns are all shaped by these types.
 *
 * Conventions:
 * - `contractMonth` / `month` keys are "YYYY-MM" strings.
 * - Settle / as-of dates are ISO "YYYY-MM-DD" strings.
 * - Human-facing date labels are M/D/YY (e.g. "7/13/26") — never M1/M6 tenor
 *   notation anywhere.
 * - Prices are already unit-scaled (CommodityCurve.unitScale applied at ingest).
 */

export type CommodityGroupCode = "OIL" | "GAS" | "NGL" | "OTHER";
export type CurveKindCode = "FLAT" | "BASIS";
export type BasisMode = "DIFF" | "OUT";
export type HistoryWindow = "OFF" | "1Y" | "2Y";
export type DeckTerminalRuleCode = "FLAT" | "STRIP_AVG" | "TRAILING_STRIP_AVG" | "ESCALATE";

/** One point on a strip: a contract month and its settle price. */
export interface CurvePoint {
  contractMonth: string; // "2026-08"
  price: number;
}

/** Registry row served to the client. */
export interface CurveInfoDto {
  code: string;
  name: string;
  group: CommodityGroupCode;
  kind: CurveKindCode;
  unit: string;
  decimals: number;
  benchCode: string | null;
  /** AEGIS Product label ("Natural Gasoline", "RINs") — directory sub-headings. */
  product: string | null;
  /** Inactive curves are directory-only until first added to a set. */
  isActive: boolean;
  sortOrder: number;
  /** Prompt-month price from the latest snapshot (basis curves: the diff). */
  latestPrompt: number | null;
  latestSettleDate: string | null; // ISO
}

export type VintageId = "LATEST" | "1D" | "1W" | "1M" | "3M" | "6M" | "1Y";

/** A vintage request resolved against actually-available snapshot dates. */
export interface ResolvedVintage {
  id: VintageId;
  lagTradingDays: number;
  targetDate: string; // ISO — latest settle minus the lag
  /** Actual snapshot date used (nearest earlier available), null if none exists. */
  resolvedDate: string | null;
}

export interface VintageSeries {
  id: VintageId;
  resolvedDate: string; // ISO — exact snapshot date served
  points: CurvePoint[];
}

export interface HistoryMonthDto {
  month: string; // "YYYY-MM"
  avgSettle: number;
}

/** GET /curves/:code/vintages response. */
export interface CurveVintagesDto {
  code: string;
  name: string;
  kind: CurveKindCode;
  unit: string;
  decimals: number;
  basisMode: BasisMode;
  benchCode: string | null;
  latestSettleDate: string; // ISO
  latest: CurvePoint[];
  vintages: VintageSeries[];
  resolved: ResolvedVintage[]; // includes unavailable ones (resolvedDate null)
  history: HistoryMonthDto[]; // empty unless requested
  snapshotCount: number; // for "accruing N/251" states
}

/** Strip-board row (BAL-26, CAL-27, 12M, ...). */
export interface StripBoardRow {
  label: string;
  price: number | null;
  deltas: { vintageId: VintageId; resolvedDate: string | null; abs: number | null; pct: number | null }[];
}

export interface CurveStructureDto {
  backwardated: boolean | null;
  prompt: number | null;
  promptMonth: string | null; // "YYYY-MM"
  promptMinus2nd: number | null;
  promptMinus12th: number | null;
  rollYield1YPct: number | null;
  promptDeltaVs1Y: number | null;
  vintage1YDate: string | null;
}

export interface SeasonalityRow {
  label: string; // "WIN 26/27" | "SUM 27"
  price: number | null;
  delta1M: number | null;
}

export interface SeasonalityDto {
  rows: SeasonalityRow[];
  winterSummerSpread: number | null;
}

/** Vintage-delta grid: one row per prior vintage, tenor + strip columns. */
export interface VintageDeltaCell {
  abs: number | null;
  pct: number | null;
}

export interface VintageDeltaRow {
  vintageId: VintageId;
  resolvedDate: string; // ISO
  cells: VintageDeltaCell[];
}

export interface TenorColumn {
  label: string; // "1M" | "3M" | ... | "12M AVG"
  contractMonth: string | null; // "YYYY-MM" for point tenors, null for strips
}

export interface CurveAnalyticsDto {
  code: string;
  basisMode: BasisMode;
  latestSettleDate: string;
  stripBoard: StripBoardRow[];
  structure: CurveStructureDto;
  seasonality: SeasonalityDto | null; // gas-group curves only
  tenorColumns: TenorColumn[];
  deltaGrid: VintageDeltaRow[];
  snapshotCount: number;
}

// --- Curve sets (per-user) ---

export interface CurveSetItemDto {
  curveCode: string;
  sortOrder: number;
  pinned: boolean;
}

export interface CurveSetDto {
  id: string;
  name: string;
  items: CurveSetItemDto[];
}

// --- Price decks (per-user) ---

export interface PriceDeckDto {
  id: string;
  name: string;
  stripMonths: number;
  terminalRule: DeckTerminalRuleCode;
  terminalValueOil: number | null;
  terminalValueGas: number | null;
  terminalValueNgl: number | null;
  escalationPctPerYear: number | null;
  haircutPct: number | null;
  horizonMonths: number;
}

export type DeckExpansionResult =
  | { ok: true; months: { month: string; price: number }[] }
  | { ok: false; reason: "BASIS_NOT_ALLOWED" | "NO_STRIP" | "NO_TERMINAL_VALUE" };

// --- Export ---

export interface ExportTableDto {
  /** Header row: "CONTRACT" then one per curve: `NAME [BASIS] (UNIT) M/D/YY`. */
  headers: string[];
  /** One row per contract month, futures only — never history. */
  rows: (string | number | null)[][];
}

// --- History/futures bridge ---

export interface BridgePoint {
  month: string; // "YYYY-MM"
  price: number;
  type: "HIST" | "FUT";
}

// --- Ingest ---

export interface CommoditiesIngestSummary {
  startedAt: string;
  finishedAt: string;
  curves: number;
  snapshotsUpserted: number;
  historyMonthsUpserted: number;
  backfilledCurves: string[];
  failed: { code: string; error: string }[];
  /** True when AEGIS rejected credentials — surface loudly (token expiry). */
  authFailed: boolean;
}
