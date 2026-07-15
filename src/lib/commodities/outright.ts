import type { CurvePoint } from "@/types/commodities";

/**
 * Converts a basis (differential) strip into outright prices by joining it
 * against its benchmark strip on the contract-month key. Only months present
 * in BOTH strips are emitted — a missing bench month drops the point rather
 * than emitting a null price. Output preserves the basis strip's (ascending)
 * order. Pure.
 */
export function toOutright(
  basisPoints: CurvePoint[],
  benchPoints: CurvePoint[],
): CurvePoint[] {
  const bench = new Map<string, number>();
  for (const p of benchPoints) bench.set(p.contractMonth, p.price);
  const out: CurvePoint[] = [];
  for (const p of basisPoints) {
    const b = bench.get(p.contractMonth);
    if (b === undefined) continue;
    out.push({ contractMonth: p.contractMonth, price: b + p.price });
  }
  return out;
}
