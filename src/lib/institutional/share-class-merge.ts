/**
 * Share-class economic merge (Engine 3, blocking prerequisite) — pure, DB-free.
 *
 * A single issuer that trades under multiple 13F symbols (Alphabet GOOG + GOOGL,
 * Fox FOX + FOXA, …) is ONE economic position. Left unmerged, a fund holding both
 * classes is counted as two holders / two initiations / two exits, which
 * double-counts breadth, follow attribution, cluster detection, and flow. This
 * module folds sibling class symbols into a single CANONICAL ticker so every
 * downstream computation (breadth, initiations, tenure, clusters, exits, flow)
 * consumes one merged position per (fund, issuer, quarter).
 *
 * Curated + high-confidence ONLY (mirrors rename-map.ts). Key = the symbol to fold
 * away; value = the surviving canonical symbol. Canonical choice = the more liquid /
 * better price-covered class that resolves in the Security master:
 *   GOOG (class C, non-voting) → GOOGL (class A)
 *   FOX  (class B)            → FOXA (class A)
 * (LEN.B / BRK.A carry no tracked-fund holdings, so they are intentionally absent.)
 *
 * Share counts across near-parity classes are summed as an approximation of the
 * combined economic position; reported $ value — the basis for weight / % of book —
 * is summed exactly. Raw per-class rows are retained by the caller for reconciliation.
 */

/** old (non-canonical) symbol → surviving canonical symbol. */
export const SHARE_CLASS_CANONICAL: Record<string, string> = {
  GOOG: "GOOGL",
  FOX: "FOXA",
};

/** The canonical economic ticker for a symbol (itself if it has no sibling map). */
export function canonicalTicker(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  return SHARE_CLASS_CANONICAL[t] ?? t;
}

/** True when `ticker` is a non-canonical class that folds into a sibling. */
export function isNonCanonicalClass(ticker: string): boolean {
  const t = ticker.trim().toUpperCase();
  return t in SHARE_CLASS_CANONICAL && SHARE_CLASS_CANONICAL[t] !== t;
}

/** Minimal position shape the merge needs. Callers extend it with their own fields. */
export interface MergeablePosition {
  ticker: string;
  shares: number;
  value: number;
}

export interface MergedPosition<T extends MergeablePosition> {
  /** Canonical ticker after the fold. */
  ticker: string;
  shares: number;
  value: number;
  /** The source rows that were folded into this position (1 when no merge happened). */
  sources: T[];
  /** Non-canonical tickers folded away (empty when nothing merged). */
  mergedFrom: string[];
}

/**
 * Fold a single (fund, quarter) book's positions to one row per canonical issuer.
 * Deterministic: canonical rows sort by ticker; sources preserve input order.
 * Shares and value are summed across sibling classes; `mergedFrom` records which
 * non-canonical symbols were absorbed so the caller can badge / reconcile.
 */
export function mergeShareClassPositions<T extends MergeablePosition>(
  positions: T[],
): Array<MergedPosition<T>> {
  const byCanonical = new Map<string, MergedPosition<T>>();
  for (const p of positions) {
    const canon = canonicalTicker(p.ticker);
    const cur =
      byCanonical.get(canon) ??
      ({ ticker: canon, shares: 0, value: 0, sources: [], mergedFrom: [] } as MergedPosition<T>);
    cur.shares += Number.isFinite(p.shares) ? p.shares : 0;
    cur.value += Number.isFinite(p.value) ? p.value : 0;
    cur.sources.push(p);
    if (canon !== p.ticker.trim().toUpperCase() && !cur.mergedFrom.includes(p.ticker.trim().toUpperCase())) {
      cur.mergedFrom.push(p.ticker.trim().toUpperCase());
    }
    byCanonical.set(canon, cur);
  }
  return Array.from(byCanonical.values()).sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
}
