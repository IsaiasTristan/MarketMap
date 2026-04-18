export type DateClose = { date: string; adjClose: number };

/**
 * Inner join on calendar date (YYYY-MM-DD). Both inputs ascending by date.
 */
export function alignCloseSeries(
  stock: DateClose[],
  bench: DateClose[]
): { dates: string[]; stock: number[]; bench: number[] } {
  const mapB = new Map(bench.map((r) => [r.date, r.adjClose]));
  const dates: string[] = [];
  const s: number[] = [];
  const b: number[] = [];
  for (const row of stock) {
    const bb = mapB.get(row.date);
    if (bb !== undefined) {
      dates.push(row.date);
      s.push(row.adjClose);
      b.push(bb);
    }
  }
  return { dates, stock: s, bench: b };
}

/** Calendar intersection across N price series (ascending dates). */
export function intersectAlignedCloses(
  seriesList: DateClose[][]
): { dates: string[]; matrix: number[][] } {
  if (seriesList.length === 0) return { dates: [], matrix: [] };
  const sets = seriesList.map((s) => new Set(s.map((x) => x.date)));
  const common = [...sets[0]!].filter((d) =>
    sets.every((set) => set.has(d))
  );
  common.sort();
  const matrix = seriesList.map((s) => {
    const m = new Map(s.map((r) => [r.date, r.adjClose]));
    return common.map((d) => m.get(d)!);
  });
  return { dates: common, matrix };
}

/** One vector per trading day (length = #dates - 1). */
export function dailyReturnVectorsFromMatrix(matrix: number[][]): number[][] {
  const n = matrix[0]?.length ?? 0;
  if (n < 2) return [];
  const out: number[][] = [];
  for (let i = 1; i < n; i++) {
    const day: number[] = [];
    for (let j = 0; j < matrix.length; j++) {
      const prev = matrix[j]![i - 1]!;
      const cur = matrix[j]![i]!;
      day.push(prev === 0 ? 0 : cur / prev - 1);
    }
    out.push(day);
  }
  return out;
}
