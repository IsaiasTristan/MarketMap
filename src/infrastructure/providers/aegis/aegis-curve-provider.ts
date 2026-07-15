/**
 * AEGIS OData adapter for the FuturesCurveProvider port. Endpoint shapes
 * verified live 2026-07-14/15:
 *
 * - MarketData.ForDate(asOfDate=YYYY-MM-DD,productCodes='CL')
 *     → [{ Name, Code, Product, AsOfDate, DeliveryDate: "2026-08-01", Price }]
 * - MarketData.ForDateRange(asOfStart,asOfEnd,productCode='CL')  [singular!]
 *     → same rows, one strip per AsOfDate in the range
 * - CombinedCurves.ForDateRange(asOfDate,productCodes,startDate,endDate)
 *     → keys contain spaces: { "As Of", "Delivery Date", Price,
 *       "Settle/Forward": "Settle" | "Forward" } — Settle rows are the
 *       realized settlement per past delivery month (the bridge's history).
 *
 * Unknown product codes return HTTP 200 + empty (never an error) → "empty".
 * All prices are multiplied by curve.unitScale before leaving the adapter.
 */
import type { CurvePoint } from "@/types/commodities";
import { monthKeyFromIso } from "@/lib/commodities/format";
import { aegisGetValues } from "./aegis-client";
import type { CurveFetchResult, CurveRef, FuturesCurveProvider } from "../futures-curve";

interface AegisMarketDataRow {
  Code: string;
  AsOfDate: string;
  DeliveryDate: string;
  Price: number;
}

interface AegisCombinedRow {
  Code: string;
  ["As Of"]: string;
  ["Delivery Date"]: string;
  Price: number;
  ["Settle/Forward"]: "Settle" | "Forward";
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Gap between consecutive AEGIS calls inside one curve's fetch (politeness). */
const CALL_GAP_MS = 400;

function toPoints(rows: AegisMarketDataRow[], unitScale: number): CurvePoint[] {
  return rows
    .filter((r) => Number.isFinite(r.Price) && typeof r.DeliveryDate === "string")
    .map((r) => ({ contractMonth: monthKeyFromIso(r.DeliveryDate), price: r.Price * unitScale }))
    .sort((a, b) => (a.contractMonth < b.contractMonth ? -1 : 1));
}

export class AegisOdataCurveProvider implements FuturesCurveProvider {
  readonly id = "aegis-odata";

  async fetchCurve(curve: CurveRef, asOf?: string): Promise<CurveFetchResult> {
    if (!curve.providerSymbolRoot) return { kind: "error", reason: "no providerSymbolRoot" };
    const code = encodeURIComponent(curve.providerSymbolRoot);

    // Without an explicit as-of, walk back from today up to 6 calendar days to
    // find the most recent settle (weekends/holidays return empty strips).
    const candidates = asOf
      ? [asOf]
      : Array.from({ length: 7 }, (_, i) => isoAddDays(new Date().toISOString().slice(0, 10), -i));

    for (const [i, day] of candidates.entries()) {
      if (i > 0) await sleep(CALL_GAP_MS);
      const rows = await aegisGetValues<AegisMarketDataRow>(
        `/MarketData.ForDate(asOfDate=${day},productCodes='${code}')`,
      );
      if (rows.length > 0) {
        const settleDate = rows[0]!.AsOfDate ?? day;
        return { kind: "ok", settleDate, points: toPoints(rows, curve.unitScale) };
      }
      if (asOf) break; // explicit date requested — don't walk back
    }
    return { kind: "empty" };
  }

  async fetchCurveRange(
    curve: CurveRef,
    asOfStart: string,
    asOfEnd: string,
  ): Promise<Map<string, CurvePoint[]>> {
    const out = new Map<string, CurvePoint[]>();
    if (!curve.providerSymbolRoot) return out;
    const code = encodeURIComponent(curve.providerSymbolRoot);

    // Chunk the as-of range into ≤31-day windows: wide OData windows risk
    // server-side truncation (same failure mode as the FMP earnings calendar).
    let chunkStart = asOfStart;
    while (chunkStart <= asOfEnd) {
      const chunkEnd = isoAddDays(chunkStart, 30) < asOfEnd ? isoAddDays(chunkStart, 30) : asOfEnd;
      const rows = await aegisGetValues<AegisMarketDataRow>(
        `/MarketData.ForDateRange(asOfStart=${chunkStart},asOfEnd=${chunkEnd},productCode='${code}')`,
      );
      const byAsOf = new Map<string, AegisMarketDataRow[]>();
      for (const r of rows) {
        if (typeof r.AsOfDate !== "string") continue;
        const list = byAsOf.get(r.AsOfDate) ?? [];
        list.push(r);
        byAsOf.set(r.AsOfDate, list);
      }
      for (const [settleDate, dayRows] of byAsOf) {
        out.set(settleDate, toPoints(dayRows, curve.unitScale));
      }
      chunkStart = isoAddDays(chunkEnd, 1);
      if (chunkStart <= asOfEnd) await sleep(CALL_GAP_MS);
    }
    return out;
  }

  async fetchRealizedMonthly(
    curve: CurveRef,
    fromMonth: string,
    asOf: string,
  ): Promise<{ month: string; avgSettle: number }[]> {
    if (!curve.providerSymbolRoot) return [];
    const code = encodeURIComponent(curve.providerSymbolRoot);
    const rows = await aegisGetValues<AegisCombinedRow>(
      `/CombinedCurves.ForDateRange(asOfDate=${asOf},productCodes='${code}',startDate=${fromMonth}-01,endDate=${asOf})`,
    );
    const asOfMonth = monthKeyFromIso(asOf);
    return rows
      .filter(
        (r) =>
          r["Settle/Forward"] === "Settle" &&
          Number.isFinite(r.Price) &&
          typeof r["Delivery Date"] === "string",
      )
      .map((r) => ({ month: monthKeyFromIso(r["Delivery Date"]), avgSettle: r.Price * curve.unitScale }))
      // Include the as-of month itself: for a curve whose prompt has rolled
      // (WTI settle 7/13 → strip starts 2026-08) the July contract has already
      // settled and belongs to realized history. Strip-collision dedup happens
      // at the bridge (futures win).
      .filter((r) => r.month >= fromMonth && r.month <= asOfMonth)
      .sort((a, b) => (a.month < b.month ? -1 : 1));
  }
}
