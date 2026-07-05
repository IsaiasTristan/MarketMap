/**
 * Fund search — pure client-side matcher (Fund Overview Part 6). DB-free.
 *
 * The signal+context universe is small enough to ship as one indexed payload and
 * match in the browser (no network round-trip per keystroke). Match quality tiers,
 * best-first: CIK exact-prefix > name/alias prefix > word-start > substring > fuzzy
 * subsequence. Ties break by: saved funds first, then signal over context, then 13F
 * AUM, then name. Aliases (short names, manager names, former filer names) are indexed
 * alongside the official name so "GAMCO", "Buffett", "Harris" resolve to the canonical
 * fund.
 */

export type FundTierValue = "signal" | "context";

export interface FundIndexEntry {
  cik: string;
  name: string;
  category: string;
  tier: FundTierValue;
  isElite: boolean;
  aum13fUsd: number | null;
  /** In the user's saved/default peer set — ranked above non-saved on equal match. */
  saved: boolean;
  /** Lowercased alternate names (short/manager/former); the official name is added implicitly. */
  aliases: string[];
}

export type MatchKind = "cik" | "prefix" | "word" | "substring" | "fuzzy";
const KIND_RANK: Record<MatchKind, number> = { cik: 5, prefix: 4, word: 3, substring: 2, fuzzy: 1 };

export interface FundSearchResult extends FundIndexEntry {
  matchKind: MatchKind;
  /** The string that matched (official name or an alias). */
  matchedOn: string;
  /** Composite score (higher = better); primarily the match-kind rank. */
  score: number;
}

/** True if all chars of `q` appear in order within `t` (subsequence / fuzzy). */
function isSubsequence(q: string, t: string): boolean {
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
  return i === q.length;
}

/** Best match kind of a query against one candidate string (or null). */
function matchString(q: string, s: string): MatchKind | null {
  const t = s.toLowerCase();
  if (t.startsWith(q)) return "prefix";
  if (t.split(/[\s.,&/-]+/).some((w) => w.startsWith(q))) return "word";
  if (t.includes(q)) return "substring";
  if (isSubsequence(q, t)) return "fuzzy";
  return null;
}

export interface SearchOptions {
  maxResults?: number;
}

/** Rank the fund index against a query. Empty query → []. */
export function searchFunds(query: string, index: FundIndexEntry[], opts: SearchOptions = {}): FundSearchResult[] {
  const max = opts.maxResults ?? 8;
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const digits = query.replace(/\D/g, "");
  const isCikQuery = digits.length > 0 && /^\s*\d[\d\s]*$/.test(query);

  const results: FundSearchResult[] = [];
  for (const f of index) {
    let best: { kind: MatchKind; on: string } | null = null;

    // CIK exact-prefix: match the padded CIK or its zero-stripped form against the
    // entered digits (so "934639" and "0000934639" both hit CIK 0000934639).
    if (isCikQuery) {
      const bareCik = f.cik.replace(/^0+/, "");
      const bareQ = digits.replace(/^0+/, "");
      if (f.cik.startsWith(digits) || (bareQ.length > 0 && bareCik.startsWith(bareQ))) best = { kind: "cik", on: f.cik };
    }

    if (!best) {
      const candidates = [f.name, ...f.aliases];
      for (const c of candidates) {
        const kind = matchString(q, c);
        if (kind && (!best || KIND_RANK[kind] > KIND_RANK[best.kind])) best = { kind, on: c };
        if (best && best.kind === "prefix") break; // can't beat a prefix among text fields
      }
    }

    if (best) {
      results.push({ ...f, matchKind: best.kind, matchedOn: best.on, score: KIND_RANK[best.kind] });
    }
  }

  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score; // match quality
    if (a.saved !== b.saved) return a.saved ? -1 : 1; // saved first
    if (a.tier !== b.tier) return a.tier === "signal" ? -1 : 1; // signal over context
    const av = a.aum13fUsd ?? -1;
    const bv = b.aum13fUsd ?? -1;
    if (av !== bv) return bv - av; // larger 13F AUM
    return a.name.localeCompare(b.name);
  });

  return results.slice(0, max);
}
