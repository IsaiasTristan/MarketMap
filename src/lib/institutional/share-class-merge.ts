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
 * Curated + high-confidence ONLY. Key = the symbol to fold away; value = the
 * surviving canonical symbol. Canonical direction is DATA-DRIVEN: fold into the
 * price-covered class when exactly one is covered in the Security master, else into
 * the more widely-held class. Every pair is a common dual-class of ONE issuer
 * (voting/non-voting of the same equity); preferred/ADR-preferred (e.g. PBR-A) are
 * deliberately excluded — economically distinct instruments, not a share class.
 *
 * $ value (basis for weight / % of book) and pctOfBook are summed EXACTLY. Share
 * counts are NOT naively summed — A and B classes are not unit-comparable (1 BRK-A
 * ≈ 1500 BRK-B), so a fold expresses the combined position in CANONICAL-class share-
 * equivalents (totalValue / the canonical class's own implied price). Near-parity
 * classes (GOOG/GOOGL) are unchanged by this since both prices ≈ equal. Raw per-class
 * rows are retained by the caller for reconciliation.
 */

/** old (non-canonical) symbol → surviving canonical symbol. Tickers use the DB's
 *  hyphen form (BRK-A, not BRK.A). */
export const SHARE_CLASS_CANONICAL: Record<string, string> = {
  // near-parity classes (price-covered)
  GOOG: "GOOGL", // Alphabet class C → class A
  FOX: "FOXA", // Fox class B → class A
  // fold the UNCOVERED class into its PRICE-COVERED sibling (improves price coverage)
  "LEN-B": "LEN", // Lennar class B → common
  "HEI-A": "HEI", // Heico class A → common
  "GTN-A": "GTN", // Gray Television class A → common
  "CWEN-A": "CWEN", // Clearway Energy class A → class C
  "UHAL-B": "UHAL", // U-Haul non-voting → common
  "MKC-V": "MKC", // McCormick voting → common
  // neither class price-covered → fold into the more widely-held class
  "BRK-A": "BRK-B", // Berkshire class A → class B (B far more liquid)
  "BF-A": "BF-B", // Brown-Forman class A → class B
  "MOG-B": "MOG-A", // Moog class B → class A
  "LGF-A": "LGF-B", // Lionsgate class A → class B
  "CRD-B": "CRD-A", // Crawford class B → class A
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

const fin = (n: number): number => (Number.isFinite(n) ? n : 0);

/**
 * Canonical-unit share count for a merged issuer: the combined $ position valued at
 * the CANONICAL class's own implied price (value/shares). This expresses A + B in a
 * single share unit — correct for non-parity classes (BRK-A/BRK-B), and a no-op for
 * near-parity ones. Falls back to a raw share-sum only when the canonical class is
 * absent (a lone non-canonical holding → keep its own units) or has no price.
 */
export function canonicalUnitShares(
  canonShares: number,
  canonValue: number,
  totalValue: number,
  foldShares: number,
): number {
  const price = canonShares > 0 ? canonValue / canonShares : null;
  return price && price > 0 ? totalValue / price : canonShares + foldShares;
}

/**
 * Fold a single (fund, quarter) book's positions to one row per canonical issuer.
 * Deterministic: canonical rows sort by ticker; sources preserve input order. $ value
 * is summed exactly; shares are expressed in canonical-class units (see
 * canonicalUnitShares) so non-parity classes do not produce nonsense share counts.
 * `mergedFrom` records which non-canonical symbols were absorbed.
 */
export function mergeShareClassPositions<T extends MergeablePosition>(
  positions: T[],
): Array<MergedPosition<T>> {
  interface Acc extends MergedPosition<T> {
    canonShares: number;
    canonValue: number;
    foldShares: number;
  }
  const byCanonical = new Map<string, Acc>();
  for (const p of positions) {
    const canon = canonicalTicker(p.ticker);
    const raw = p.ticker.trim().toUpperCase();
    const cur =
      byCanonical.get(canon) ??
      ({ ticker: canon, shares: 0, value: 0, sources: [], mergedFrom: [], canonShares: 0, canonValue: 0, foldShares: 0 } as Acc);
    cur.value += fin(p.value);
    if (raw === canon) {
      cur.canonShares += fin(p.shares);
      cur.canonValue += fin(p.value);
    } else {
      cur.foldShares += fin(p.shares);
      if (!cur.mergedFrom.includes(raw)) cur.mergedFrom.push(raw);
    }
    cur.sources.push(p);
    byCanonical.set(canon, cur);
  }
  return Array.from(byCanonical.values())
    .map((a) => {
      const shares = canonicalUnitShares(a.canonShares, a.canonValue, a.value, a.foldShares);
      return { ticker: a.ticker, shares, value: a.value, sources: a.sources, mergedFrom: a.mergedFrom } as MergedPosition<T>;
    })
    .sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
}
