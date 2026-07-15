/**
 * Provider port for commodity forward curves. Adapters (AEGIS OData primary,
 * manual CSV fallback, CME settlement stub) implement this; nothing outside
 * src/infrastructure/providers calls a curve vendor directly.
 */
import type { CurvePoint } from "@/types/commodities";

/** The registry fields an adapter needs to fetch a curve. */
export interface CurveRef {
  code: string; // registry code, e.g. "WTI"
  providerSymbolRoot: string | null; // vendor product code, e.g. "CL"
  unitScale: number; // applied to every raw price (NGL $/GAL → ¢/GAL = 100)
}

/**
 * Discriminated fetch result. "empty" is distinct from "error" because AEGIS
 * returns HTTP 200 + empty for unknown product codes — an active curve
 * yielding "empty" is a data problem to report, not a success.
 */
export type CurveFetchResult =
  | { kind: "ok"; settleDate: string; points: CurvePoint[] }
  | { kind: "empty" }
  | { kind: "error"; reason: string };

export interface FuturesCurveProvider {
  readonly id: string;
  /** Latest (or as-of) full strip for one curve. */
  fetchCurve(curve: CurveRef, asOf?: string): Promise<CurveFetchResult>;
  /**
   * Historical vintages: every available settle date in [asOfStart, asOfEnd]
   * mapped to its full strip. Used for the first-run 1Y backfill.
   */
  fetchCurveRange(
    curve: CurveRef,
    asOfStart: string,
    asOfEnd: string,
  ): Promise<Map<string, CurvePoint[]>>;
  /**
   * Realized monthly history (one settle per past delivery month) from
   * `fromMonth` ("YYYY-MM") up to the month before `asOf`. AEGIS serves this
   * via CombinedCurves "Settle" rows — the contract's final settlement per
   * delivery month (not an intra-month average of daily prompts).
   */
  fetchRealizedMonthly(
    curve: CurveRef,
    fromMonth: string,
    asOf: string,
  ): Promise<{ month: string; avgSettle: number }[]>;
}
