/**
 * Short display codes for subsector keys, so the pair matrix and arrivals chips
 * can show a compact `ANA` / `NET` glyph instead of a rotated, truncated full
 * name. The full subsector name is always available in a hover, never dropped.
 *
 * Pure — no I/O, unit-tested in tests/pairs/labels.test.ts.
 */

/** Split a subsector key into word tokens on `/`, whitespace, `-`, and `&`. */
function tokenize(key: string): string[] {
  return key.split(/[/\s\-&]+/).filter(Boolean);
}

/**
 * A subsector's default code: the first token, uppercased, first 3 letters
 * (`Analog/Power` to `ANA`, `Networking/Optical` to `NET`, `AI/Compute` to
 * `AI`). Short tokens stay short. This is a heuristic, not the hand-curated
 * mockup codes, so collisions are resolved by `subsectorCodes` for a set.
 */
export function subsectorCode(key: string): string {
  const tokens = tokenize(key);
  const head = tokens[0] ?? key.trim();
  return head.toUpperCase().slice(0, 3) || key.trim().toUpperCase().slice(0, 3);
}

/**
 * Resolve codes for a whole displayed set so no two keys share a code.
 * Deterministic (keys sorted first): on a clash we widen the first token to 4
 * letters, then append the second token's initial, then a numeric suffix.
 */
export function subsectorCodes(keys: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  const unique = [...new Set(keys)].sort();
  for (const key of unique) {
    let code = subsectorCode(key);
    if (used.has(code)) {
      const tokens = tokenize(key);
      const wide = (tokens[0] ?? key.trim()).toUpperCase().slice(0, 4);
      const second = tokens[1]?.[0]?.toUpperCase() ?? "";
      if (!used.has(wide) && wide !== code) {
        code = wide;
      } else if (second && !used.has(code + second)) {
        code = code + second;
      } else {
        let n = 2;
        while (used.has(`${code}${n}`)) n++;
        code = `${code}${n}`;
      }
    }
    used.add(code);
    result.set(key, code);
  }
  return result;
}

/** `CODE/CODE` label for a long/short pair, used by the arrivals chips. */
export function pairCode(longKey: string, shortKey: string): string {
  return `${subsectorCode(longKey)}/${subsectorCode(shortKey)}`;
}

/**
 * The ONE breadth-gap formatter, shared by the pair matrix and the rank table
 * so a single stored gap can never render differently between them (a bare
 * toFixed(0) at a .5 boundary was splitting them by a unit). Signed, 1 decimal.
 */
export function formatGapPp(gap: number | null | undefined, dp = 1): string {
  if (gap === null || gap === undefined || !Number.isFinite(gap)) return "—";
  return `${gap > 0 ? "+" : ""}${gap.toFixed(dp)}`;
}
