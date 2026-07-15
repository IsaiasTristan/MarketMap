/**
 * TODO: licensed CME/ICE settlement feed adapter (production basis source).
 *
 * The COMMODITIES tab currently ingests everything from AEGIS OData
 * (AegisOdataCurveProvider), with ManualCsvCurveProvider as the manual
 * fallback. If a directly-licensed settlement feed is procured (CME DataMine,
 * ICE IDS, or a redistributor), implement the FuturesCurveProvider port here:
 * fetchCurve / fetchCurveRange from daily settlement files, and wire provider
 * selection through an env accessor (see marketDataProviderId() precedent in
 * src/infrastructure/config/env.ts). See docs/ARCHITECTURE.md § providers.
 */
import type { CurvePoint } from "@/types/commodities";
import type { CurveFetchResult, CurveRef, FuturesCurveProvider } from "./futures-curve";

export class CmeSettlementProvider implements FuturesCurveProvider {
  readonly id = "cme-settlement";

  async fetchCurve(_curve: CurveRef, _asOf?: string): Promise<CurveFetchResult> {
    return { kind: "error", reason: "CmeSettlementProvider is a stub — no licensed feed configured" };
  }

  async fetchCurveRange(): Promise<Map<string, CurvePoint[]>> {
    return new Map();
  }

  async fetchRealizedMonthly(): Promise<{ month: string; avgSettle: number }[]> {
    return [];
  }
}
