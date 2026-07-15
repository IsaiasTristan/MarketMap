import type { CurvePoint, CurveStructureDto } from "@/types/commodities";

/**
 * Curve-shape diagnostics off the latest strip: prompt level, front spreads,
 * backwardation flag, 1Y roll yield, and the prompt's move versus the 1Y
 * vintage. Pure; every field degrades to null on insufficient data (short
 * strips, missing vintage) — never throws.
 */
export function curveStructure(
  latest: CurvePoint[],
  vintage1Y: { resolvedDate: string; points: CurvePoint[] } | null,
): CurveStructureDto {
  const p0 = latest[0];
  const p1 = latest[1];
  const p11 = latest[11];

  const prompt = p0 ? p0.price : null;
  const promptMonth = p0 ? p0.contractMonth : null;
  const promptMinus2nd = p0 && p1 ? p0.price - p1.price : null;
  const promptMinus12th = p0 && p11 ? p0.price - p11.price : null;
  const backwardated = promptMinus12th === null ? null : promptMinus12th > 0;
  const rollYield1YPct =
    promptMinus12th !== null && prompt !== null && prompt !== 0
      ? (promptMinus12th / Math.abs(prompt)) * 100
      : null;

  let promptDeltaVs1Y: number | null = null;
  let vintage1YDate: string | null = null;
  if (vintage1Y) {
    vintage1YDate = vintage1Y.resolvedDate;
    if (p0) {
      // Compare like-for-like: the same contract month on the year-ago curve
      // when it's still on the board there, else that curve's own front month.
      const sameMonth = vintage1Y.points.find(
        (v) => v.contractMonth === p0.contractMonth,
      );
      const ref = sameMonth ?? vintage1Y.points[0];
      if (ref) promptDeltaVs1Y = p0.price - ref.price;
    }
  }

  return {
    backwardated,
    prompt,
    promptMonth,
    promptMinus2nd,
    promptMinus12th,
    rollYield1YPct,
    promptDeltaVs1Y,
    vintage1YDate,
  };
}
