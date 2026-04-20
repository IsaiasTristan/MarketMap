/**
 * Portfolio concentration metrics.
 */

/** Herfindahl-Hirschman Index: Σ(wᵢ²) where weights are fractions summing to 1. */
export function hhi(weights: number[]): number {
  return weights.reduce((s, w) => s + w * w, 0);
}

/** Effective N: 1 / HHI — equivalent number of independent equal-weight positions. */
export function effectiveN(weights: number[]): number {
  const h = hhi(weights);
  return h > 0 ? 1 / h : 0;
}

/** Top-K concentration: fraction of NAV in the K largest positions. */
export function topKConcentration(weights: number[], k: number): number {
  const sorted = [...weights].sort((a, b) => b - a);
  return sorted.slice(0, k).reduce((s, w) => s + w, 0);
}

/** Simple hierarchical clustering using Ward's method (average linkage approximation). */
export interface ClusterNode {
  left?: ClusterNode;
  right?: ClusterNode;
  label?: string;
  height: number;
  items: string[];
}

export function clusterCorrelation(
  tickers: string[],
  corrMatrix: number[][],
): ClusterNode {
  // Convert correlation to distance: d = 1 - |ρ| (0 = perfectly correlated)
  const n = tickers.length;
  // Create leaf nodes
  const nodes: ClusterNode[] = tickers.map((t) => ({
    label: t,
    height: 0,
    items: [t],
  }));

  // Distance matrix (1 - |corr|)
  const dist = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i === j ? 0 : 1 - Math.abs(corrMatrix[i]?.[j] ?? 0),
    ),
  );

  // Current distance matrix (we'll work with indices)
  const active = Array.from({ length: n }, (_, i) => i);
  const D = dist.map((row) => [...row]);
  const nodeList = [...nodes];

  while (active.length > 1) {
    // Find minimum distance pair
    let minDist = Infinity;
    let ii = 0, jj = 1;
    for (let a = 0; a < active.length - 1; a++) {
      for (let b = a + 1; b < active.length; b++) {
        const ai = active[a];
        const bi = active[b];
        if (D[ai][bi] < minDist) {
          minDist = D[ai][bi];
          ii = a;
          jj = b;
        }
      }
    }

    const left = nodeList[active[ii]];
    const right = nodeList[active[jj]];
    const merged: ClusterNode = {
      left,
      right,
      height: minDist,
      items: [...left.items, ...right.items],
    };
    nodeList.push(merged);
    const newIdx = nodeList.length - 1;

    // Update distance matrix (average linkage)
    D.push(
      active.map((ai) => {
        const dLeft = D[active[ii]]?.[ai] ?? Infinity;
        const dRight = D[active[jj]]?.[ai] ?? Infinity;
        return (dLeft + dRight) / 2;
      }),
    );
    D.forEach((row) => row.push(0));

    // Remove ii, jj from active; add newIdx
    const newActive = active.filter((_, k) => k !== ii && k !== jj);
    newActive.push(newIdx);
    active.splice(0, active.length, ...newActive);
  }

  return nodeList[active[0]];
}
