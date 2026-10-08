/**
 * Engine 1 — meshing two price-target event sources into one panel (pure).
 *
 * TipRanks (paid add-on, ~8x denser, true per-analyst expertUID) and the free
 * FMP price-target-news feed (news-scraped, firm-level identity only) agree on
 * VALUES where they overlap — measured 81-85% of FMP rows match a TipRanks row
 * on (normalized firm, identical target, ±4 days). They differ in panel SIZE.
 * The reconstruction therefore always reads the deduped UNION so there is no
 * source switch at subscription boundaries, only a change in density.
 *
 * Supersession key: expertUID when known; FMP rows inherit a ticker's
 * expertUID when exactly one TipRanks analyst at that firm covers the name
 * (so a post-cancellation FMP update supersedes the analyst's older TipRanks
 * target instead of double-voicing the firm), else the normalized firm.
 */

export type PtSource = "TIPRANKS" | "FMP";

export interface SourcedPtEvent {
  dateIso: string; // YYYY-MM-DD
  priceTarget: number;
  source: PtSource;
  expertUID: string | null; // TipRanks only
  firm: string | null; // raw vendor firm string
}

/** A unified event ready for reconstruction: `analyst` is the supersession key. */
export interface UnifiedPtEvent {
  dateIso: string;
  analyst: string | null;
  priceTarget: number;
  source: PtSource;
}

const FIRM_ALIASES: Record<string, string> = {
  citigroup: "citi",
  "stifel nicolaus": "stifel",
  "h c wainwright": "hc wainwright",
  "b riley": "b riley",
  briley: "b riley",
  "svb leerink": "leerink",
  "leerink partners": "leerink",
  "jmp securities": "jmp",
  "raymond james financial": "raymond james",
  "bank of america merrill lynch": "bofa",
  "bank of america": "bofa",
  "bofa securities": "bofa",
  "merrill lynch": "bofa",
  "jp morgan chase": "jpmorgan",
  "jp morgan": "jpmorgan",
  "j p morgan": "jpmorgan",
  "goldman sachs": "goldman",
  "morgan stanley co": "morgan stanley",
  "wells fargo securities": "wells fargo",
  "rbc capital markets": "rbc",
  "royal bank of canada": "rbc",
  "td cowen": "cowen",
  "td securities": "cowen",
  "bmo capital markets": "bmo",
  "keybanc capital markets": "keybanc",
  "key banc": "keybanc",
  "piper sandler companies": "piper sandler",
  "canaccord genuity": "canaccord",
  "needham company": "needham",
  "craig hallum": "craig-hallum",
  "roth mkm": "roth",
  "roth capital": "roth",
  "scotiabank global": "scotiabank",
  "bnp paribas exane": "bnp paribas",
  exane: "bnp paribas",
  "evercore isi": "evercore",
  "ubs": "ubs",
  "deutsche bank": "deutsche bank",
  "barclays": "barclays",
  "jefferies": "jefferies",
  "oppenheimer": "oppenheimer",
  "wedbush": "wedbush",
  "susquehanna international": "susquehanna",
  "susquehanna financial": "susquehanna",
  "mizuho securities": "mizuho",
  "mizuho americas": "mizuho",
  "guggenheim securities": "guggenheim",
  "loop capital": "loop",
  "loop capital markets": "loop",
  "benchmark company": "benchmark",
  "the benchmark company": "benchmark",
  "william blair company": "william blair",
  "baird": "baird",
  "robert w baird": "baird",
  "rw baird": "baird",
  "truist securities": "truist",
  "truist financial": "truist",
  "ladenburg thalmann": "ladenburg",
  "lake street capital markets": "lake street",
  "northland capital markets": "northland",
  "northland securities": "northland",
  "hsbc holdings": "hsbc",
  "macquarie group": "macquarie",
  "daiwa securities": "daiwa",
  "nomura holdings": "nomura",
  "nomura securities": "nomura",
  "cfra research": "cfra",
  "argus research": "argus",
  "dz bank": "dz bank",
  "redburn atlantic": "redburn",
  "redburn partners": "redburn",
};

const SUFFIX_RE =
  /\b(inc|incorporated|llc|lp|llp|ltd|limited|plc|co|company|corp|corporation|group|securities|research|capital|markets|partners|financial|holdings|equity|equities|and co|and company|advisors|advisory|global|international|americas|usa|us|na)\b/g;

/** Canonical lower-case firm key: strip punctuation + corporate suffixes, then alias. */
export function normalizeFirmName(name: string | null | undefined): string | null {
  if (!name) return null;
  let s = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,'"()]/g, "")
    .replace(/[-–—/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  // Alias on the lightly-cleaned form first (catches "craig hallum", "b riley", "h c wainwright").
  if (FIRM_ALIASES[s]) return FIRM_ALIASES[s];
  const stripped = s.replace(SUFFIX_RE, " ").replace(/\s+/g, " ").trim();
  s = stripped.length ? stripped : s;
  return FIRM_ALIASES[s] ?? s;
}

function dayMs(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

/**
 * Drop FMP events already represented by a TipRanks event: same normalized
 * firm, target equal to the cent, dated within `windowDays`. TipRanks rows
 * are always kept (they carry expertUID). Deterministic, order-independent.
 */
export function dedupeAcrossSources(
  tipranks: SourcedPtEvent[],
  fmp: SourcedPtEvent[],
  windowDays = 4,
): { kept: SourcedPtEvent[]; droppedFmp: number } {
  const byFirm = new Map<string, Array<{ ms: number; pt: number }>>();
  for (const e of tipranks) {
    const f = normalizeFirmName(e.firm);
    if (!f) continue;
    const arr = byFirm.get(f);
    const row = { ms: dayMs(e.dateIso), pt: e.priceTarget };
    if (arr) arr.push(row);
    else byFirm.set(f, [row]);
  }
  const win = windowDays * 86_400_000;
  const kept: SourcedPtEvent[] = [...tipranks];
  let droppedFmp = 0;
  for (const e of fmp) {
    const f = normalizeFirmName(e.firm);
    const candidates = f ? byFirm.get(f) : undefined;
    const ms = dayMs(e.dateIso);
    const dup =
      candidates?.some((c) => Math.abs(c.pt - e.priceTarget) < 0.005 && Math.abs(c.ms - ms) <= win) ?? false;
    if (dup) droppedFmp++;
    else kept.push(e);
  }
  return { kept, droppedFmp };
}

/**
 * Assign the supersession key. TipRanks rows key on expertUID. FMP rows key on
 * the firm's single known TipRanks analyst for this ticker when unambiguous,
 * else on the normalized firm (each firm = one voice, as before).
 */
export function toUnifiedEvents(events: SourcedPtEvent[]): UnifiedPtEvent[] {
  const analystsByFirm = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.source !== "TIPRANKS" || !e.expertUID) continue;
    const f = normalizeFirmName(e.firm);
    if (!f) continue;
    const set = analystsByFirm.get(f);
    if (set) set.add(e.expertUID);
    else analystsByFirm.set(f, new Set([e.expertUID]));
  }
  return events.map((e) => {
    const f = normalizeFirmName(e.firm);
    let analyst: string | null;
    if (e.source === "TIPRANKS" && e.expertUID) analyst = e.expertUID;
    else {
      const set = f ? analystsByFirm.get(f) : undefined;
      analyst = set && set.size === 1 ? [...set][0]! : f;
    }
    return { dateIso: e.dateIso, analyst, priceTarget: e.priceTarget, source: e.source };
  });
}

/** Convenience: dedupe + key in one step for a single ticker. */
export function meshPtSources(
  tipranks: SourcedPtEvent[],
  fmp: SourcedPtEvent[],
  windowDays = 4,
): { events: UnifiedPtEvent[]; droppedFmp: number } {
  const { kept, droppedFmp } = dedupeAcrossSources(tipranks, fmp, windowDays);
  return { events: toUnifiedEvents(kept), droppedFmp };
}
