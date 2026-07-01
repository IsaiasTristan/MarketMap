/**
 * Engine 3 (Institutional Capital-Flow) — Phase 0 FMP validation probe (READ-ONLY).
 *
 * Confirms, BEFORE any schema is committed, that FMP can back the 13F engine
 * against OUR actual 68-fund watchlist and universe:
 *   - which 13F / institutional-ownership endpoints the tier serves (shape
 *     discovery — we do not assume the exact paths; we probe candidates and
 *     print keys + samples),
 *   - per-filing-period reconstructability: for a fund + period, can we read
 *     {symbol|cusip, shares, value$} rows (the fact table) and derive each
 *     fund's total book (for % of book / conviction),
 *   - history depth (target >= 8 quarters) for trajectories + QoQ deltas,
 *   - the identifier join: do holdings carry `symbol` or only cusip, and how
 *     many map onto our universe,
 *   - small/mid-cap coverage — the decisive check; if it collapses on small
 *     caps, that is a finding that changes the design,
 *   - watchlist resolvability: how many of the 68 curated CIKs FMP knows.
 *
 * Makes only HTTP GETs. Writes nothing to disk or DB.
 *
 * Usage (key via argv or env / .env, never hard-coded):
 *   npx tsx scripts/institutional-fmp-validate.ts [APIKEY]
 *   FMP_API_KEY=... npx tsx scripts/institutional-fmp-validate.ts
 */

export {}; // module scope (avoids global-scope collision with other CLI probes)

// Load .env for standalone tsx runs (Next.js loads it for the app; scripts don't).
if (!process.env.FMP_API_KEY) {
  try {
    (process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile(".env");
  } catch {
    /* no .env or unsupported — fall through to argv */
  }
}

const API_KEY = process.argv[2] || process.env.FMP_API_KEY || "";
const BASE = (process.env.FMP_BASE_URL?.replace(/\/$/, "") || "https://financialmodelingprep.com");

if (!API_KEY) {
  console.error(
    "No API key. Pass as first arg, set FMP_API_KEY, or put it in .env.\n" +
      "  npx tsx scripts/institutional-fmp-validate.ts <APIKEY>",
  );
  process.exit(2);
}

// ─── Curated watchlist (from SEC_EDGAR_CIK_list_68_funds). cik is 10-digit. ──
type Fund = { n: number; name: string; cik: string; tier: 1 | 2 | 3 };
const FUNDS: Fund[] = [
  { n: 1, name: "Lone Pine Capital", cik: "0001061165", tier: 1 },
  { n: 2, name: "Viking Global", cik: "0001103804", tier: 1 },
  { n: 3, name: "Tiger Global", cik: "0001167483", tier: 1 },
  { n: 4, name: "Coatue", cik: "0001135730", tier: 1 },
  { n: 5, name: "Whale Rock", cik: "0001387322", tier: 1 },
  { n: 6, name: "Light Street", cik: "0001569049", tier: 1 },
  { n: 7, name: "D1 Capital", cik: "0001747057", tier: 1 },
  { n: 8, name: "Altimeter", cik: "0001541617", tier: 1 },
  { n: 9, name: "Durable Capital", cik: "0001798849", tier: 1 },
  { n: 10, name: "Sands Capital", cik: "0001020066", tier: 1 },
  { n: 11, name: "Akre Capital", cik: "0001112520", tier: 1 },
  { n: 12, name: "Fundsmith", cik: "0001569205", tier: 1 },
  { n: 13, name: "Polen Capital", cik: "0001034524", tier: 1 },
  { n: 14, name: "Sustainable Growth Advisers", cik: "0001290668", tier: 1 },
  { n: 15, name: "Brave Warrior", cik: "0001553733", tier: 1 },
  { n: 16, name: "Gardner Russo & Quinn", cik: "0000860643", tier: 1 },
  { n: 17, name: "Giverny Capital", cik: "0001641864", tier: 1 },
  { n: 18, name: "Ensemble Capital", cik: "0001387366", tier: 1 },
  { n: 19, name: "Broad Run", cik: "0001568621", tier: 1 },
  { n: 20, name: "Cantillon", cik: "0001279936", tier: 1 },
  { n: 21, name: "Egerton Capital", cik: "0001581811", tier: 1 },
  { n: 22, name: "Lansdowne", cik: "0001315309", tier: 1 },
  { n: 23, name: "Marshall Wace", cik: "0001318757", tier: 1 },
  { n: 24, name: "Steadfast", cik: "0001214822", tier: 1 },
  { n: 25, name: "Tybourne", cik: "0001553936", tier: 1 },
  { n: 26, name: "Hidden Lake", cik: "0001750312", tier: 1 },
  { n: 27, name: "Wedgewood", cik: "0000859804", tier: 1 },
  { n: 28, name: "Polar Capital", cik: "0001439303", tier: 1 },
  { n: 29, name: "Berkshire Hathaway", cik: "0001067983", tier: 2 },
  { n: 30, name: "Markel", cik: "0001096343", tier: 2 },
  { n: 31, name: "Pershing Square", cik: "0001336528", tier: 2 },
  { n: 32, name: "Third Point", cik: "0001040273", tier: 2 },
  { n: 33, name: "Greenlight", cik: "0001079114", tier: 2 },
  { n: 34, name: "Appaloosa", cik: "0001656456", tier: 2 },
  { n: 35, name: "Baupost", cik: "0001061768", tier: 2 },
  { n: 36, name: "Oaktree", cik: "0000949509", tier: 2 },
  { n: 37, name: "Dodge & Cox", cik: "0000200217", tier: 2 },
  { n: 38, name: "First Eagle", cik: "0001325447", tier: 2 },
  { n: 39, name: "Tweedy Browne", cik: "0000732905", tier: 2 },
  { n: 40, name: "Southeastern / Longleaf", cik: "0000807985", tier: 2 },
  { n: 41, name: "Davis Selected Advisers", cik: "0001036325", tier: 2 },
  { n: 42, name: "Ruane Cunniff & Goldfarb", cik: "0000728014", tier: 2 },
  { n: 43, name: "Hotchkis & Wiley", cik: "0001164833", tier: 2 },
  { n: 44, name: "Pzena", cik: "0001027796", tier: 2 },
  { n: 45, name: "Oakmark / Harris Associates", cik: "0000813917", tier: 2 },
  { n: 46, name: "Smead", cik: "0001427008", tier: 2 },
  { n: 47, name: "Gabelli / GAMCO", cik: "0000807249", tier: 2 },
  { n: 48, name: "Yacktman", cik: "0000905567", tier: 2 },
  { n: 49, name: "Diamond Hill", cik: "0001217541", tier: 2 },
  { n: 50, name: "FPA", cik: "0001377581", tier: 2 },
  { n: 51, name: "Artisan Partners", cik: "0001466153", tier: 2 },
  { n: 52, name: "Mar Vista", cik: "0001419999", tier: 2 },
  { n: 53, name: "Vulcan Value", cik: "0001556785", tier: 2 },
  { n: 54, name: "Elliott", cik: "0001791786", tier: 3 },
  { n: 55, name: "Starboard Value", cik: "0001517137", tier: 3 },
  { n: 56, name: "ValueAct", cik: "0001351069", tier: 3 },
  { n: 57, name: "Trian", cik: "0001345471", tier: 3 },
  { n: 58, name: "Jana Partners", cik: "0001159159", tier: 3 },
  { n: 59, name: "Corvex", cik: "0001535472", tier: 3 },
  { n: 60, name: "Sachem Head", cik: "0001582090", tier: 3 },
  { n: 61, name: "Politan", cik: "0001885245", tier: 3 },
  { n: 62, name: "Engaged Capital", cik: "0001559771", tier: 3 },
  { n: 63, name: "Legion Partners", cik: "0001560207", tier: 3 },
  { n: 64, name: "Ancora", cik: "0001446114", tier: 3 },
  { n: 65, name: "Inclusive Capital", cik: "0001817187", tier: 3 },
  { n: 66, name: "Land & Buildings", cik: "0001536520", tier: 3 },
  { n: 67, name: "Eminence", cik: "0001107310", tier: 3 },
  { n: 68, name: "Scopia", cik: "0001279150", tier: 3 },
];

// Small/mid-cap discovery names (from the target mockups) + mega controls.
const SMALL_CAPS = ["CRDO", "IONQ", "RXRX", "PRME", "ASTS", "AEVA"];
const MEGA_CAPS = ["AAPL", "NVDA"];

// Filing periods to probe (as-of 2026-06-30: latest settled 13F is Q1 2026).
const QUARTERS: Array<{ year: number; quarter: number }> = [
  { year: 2026, quarter: 1 },
  { year: 2025, quarter: 4 },
  { year: 2025, quarter: 3 },
  { year: 2024, quarter: 4 },
  { year: 2022, quarter: 4 },
  { year: 2020, quarter: 4 },
  { year: 2018, quarter: 4 },
];

// ─── HTTP probe helper ─────────────────────────────────────────────────────
type ProbeResult = {
  label: string;
  url: string;
  status: number;
  ok: boolean;
  kind: "array" | "object" | "empty" | "error" | "non-json";
  count: number;
  errorMessage?: string;
  firstKeys?: string[];
  dateRange?: { earliest: string; latest: string; field: string } | null;
  sample?: unknown;
};

function withKey(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${BASE}${path}${sep}apikey=${API_KEY}`;
}
function redact(url: string): string {
  return url.replace(/apikey=[^&]+/, "apikey=***");
}
function cikUnpadded(cik: string): string {
  return String(Number(cik));
}
function findDateRange(rows: Array<Record<string, unknown>>) {
  const candidates = ["date", "filingDate", "acceptedDate", "reportedDate", "periodOfReport"];
  const field = candidates.find((c) => rows.some((r) => typeof r[c] === "string"));
  if (!field) return null;
  const dates = rows
    .map((r) => r[field])
    .filter((v): v is string => typeof v === "string")
    .sort();
  if (dates.length === 0) return null;
  return { earliest: dates[0]!, latest: dates[dates.length - 1]!, field };
}

async function probe(label: string, path: string): Promise<ProbeResult> {
  const url = withKey(path);
  const base: ProbeResult = { label, url: redact(url), status: 0, ok: false, kind: "error", count: 0 };
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "MarketMap/1.0 (+institutional-engine-validate)" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    base.errorMessage = e instanceof Error ? e.message : String(e);
    return base;
  }
  base.status = res.status;
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    base.kind = "non-json";
    base.errorMessage = text.slice(0, 200);
    return base;
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if (typeof obj["Error Message"] === "string") {
      base.errorMessage = obj["Error Message"] as string;
      return base;
    }
    base.kind = "object";
    base.ok = res.ok;
    base.count = 1;
    base.firstKeys = Object.keys(obj);
    base.sample = obj;
    return base;
  }
  if (Array.isArray(body)) {
    base.ok = res.ok;
    base.count = body.length;
    if (body.length === 0) {
      base.kind = "empty";
      return base;
    }
    base.kind = "array";
    const rows = body as Array<Record<string, unknown>>;
    base.firstKeys = Object.keys(rows[0]!);
    base.dateRange = findDateRange(rows);
    base.sample = rows[0];
    return base;
  }
  base.kind = "non-json";
  base.errorMessage = String(body).slice(0, 200);
  return base;
}

function printResult(r: ProbeResult): void {
  console.log(`[${r.ok ? "OK " : "!! "}] ${r.label}  (HTTP ${r.status}, ${r.kind}, n=${r.count})`);
  console.log(`      ${r.url}`);
  if (r.errorMessage) console.log(`      error: ${r.errorMessage}`);
  if (r.dateRange)
    console.log(`      date "${r.dateRange.field}": ${r.dateRange.earliest} -> ${r.dateRange.latest}`);
  if (r.firstKeys) console.log(`      keys: ${r.firstKeys.join(", ")}`);
  if (r.sample !== undefined) console.log(`      sample: ${JSON.stringify(r.sample).slice(0, 700)}`);
  console.log("");
}

const gap = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const BRK = FUNDS.find((f) => f.name.startsWith("Berkshire"))!; // guaranteed large filer
  const bpad = BRK.cik;
  const bun = cikUnpadded(BRK.cik);

  console.log("=".repeat(80));
  console.log(`Engine 3 — FMP 13F Phase-0 probe | key ***${API_KEY.slice(-4)} | base ${BASE}`);
  console.log(`Watchlist: ${FUNDS.length} funds | discovery small-caps: ${SMALL_CAPS.join(",")}`);
  console.log("=".repeat(80), "\n");

  // ── A. Key check ──────────────────────────────────────────────────────────
  console.log("── A. Key check ─────────────────────────────────────────────────────\n");
  const keyRes = await probe("profile (key check)", `/stable/profile?symbol=AAPL`);
  printResult(keyRes);
  await gap();

  // ── B. Endpoint shape discovery (Berkshire, recent quarter) ────────────────
  // We do NOT assume the exact path; probe candidates across /stable and v3/v4,
  // padded + unpadded CIK, so the real field shapes reveal themselves.
  console.log("── B. Holdings-endpoint discovery (Berkshire) ───────────────────────\n");
  const disc: Array<{ label: string; path: string }> = [
    { label: "stable extract padded 2025Q4", path: `/stable/institutional-ownership/extract?cik=${bpad}&year=2025&quarter=4` },
    { label: "stable extract unpadded 2025Q4", path: `/stable/institutional-ownership/extract?cik=${bun}&year=2025&quarter=4` },
    { label: "stable extract padded 2026Q1", path: `/stable/institutional-ownership/extract?cik=${bpad}&year=2026&quarter=1` },
    { label: "stable holdings padded 2025Q4", path: `/stable/institutional-ownership/portfolio-holdings?cik=${bpad}&year=2025&quarter=4` },
    { label: "stable holder-perf-summary padded", path: `/stable/institutional-ownership/holder-performance-summary?cik=${bpad}&page=0` },
    { label: "stable holder-industry-breakdown", path: `/stable/institutional-ownership/holder-industry-breakdown?cik=${bpad}&year=2025&quarter=4` },
    { label: "stable filing-dates padded", path: `/stable/institutional-ownership/filing-dates?cik=${bpad}` },
    { label: "stable latest list", path: `/stable/institutional-ownership/latest?page=0&limit=5` },
    { label: "v4 portfolio-holdings padded (date)", path: `/api/v4/institutional-ownership/portfolio-holdings?cik=${bpad}&date=2025-12-31&page=0` },
    { label: "v4 portfolio-date list", path: `/api/v4/institutional-ownership/portfolio-date?cik=${bpad}` },
    { label: "v3 form-thirteen padded (date)", path: `/api/v3/form-thirteen/${bpad}?date=2025-12-31` },
    { label: "v3 form-thirteen unpadded (date)", path: `/api/v3/form-thirteen/${bun}?date=2025-12-31` },
  ];
  const discResults: ProbeResult[] = [];
  for (const d of disc) {
    const r = await probe(d.label, d.path);
    printResult(r);
    discResults.push(r);
    await gap();
  }

  // Pick the winning per-fund holdings endpoint (returns rows with a $ value field).
  const valueKeys = ["value", "marketValue", "valueUsd", "sharesValue"];
  const shareKeys = ["shares", "sharesNumber", "sharesHeld", "numberOfShares"];
  const winner = discResults.find(
    (r) => r.ok && r.count > 1 && r.firstKeys?.some((k) => valueKeys.includes(k)),
  ) ?? discResults.find((r) => r.ok && r.count > 1);
  console.log(`>>> Best holdings endpoint: ${winner ? winner.label : "NONE FOUND"}\n`);

  // ── C. History depth on the winning endpoint (Berkshire, many quarters) ────
  console.log("── C. History depth (Berkshire per-quarter holding counts) ──────────\n");
  // Reconstruct the winning path template by swapping year/quarter.
  const depth: Array<{ q: string; count: number; hasValue: boolean; hasShares: boolean }> = [];
  if (winner && /extract|portfolio-holdings/.test(winner.label)) {
    for (const { year, quarter } of QUARTERS) {
      const path = `/stable/institutional-ownership/extract?cik=${bpad}&year=${year}&quarter=${quarter}`;
      const r = await probe(`${year}Q${quarter}`, path);
      const hasValue = !!r.firstKeys?.some((k) => valueKeys.includes(k));
      const hasShares = !!r.firstKeys?.some((k) => shareKeys.includes(k));
      depth.push({ q: `${year}Q${quarter}`, count: r.count, hasValue, hasShares });
      console.log(`   ${year}Q${quarter}: n=${r.count} value=${hasValue} shares=${hasShares}`);
      await gap();
    }
  } else {
    console.log("   (skipped — no extract-style endpoint won discovery; see section B)\n");
  }
  console.log("");

  // ── D. Small/mid-cap coverage (symbol-level institutional presence) ────────
  console.log("── D. Small/mid-cap coverage (symbol positions summary) ─────────────\n");
  const symCov: Array<{ sym: string; holders: number | string; ok: boolean; keys?: string[] }> = [];
  for (const sym of [...SMALL_CAPS, ...MEGA_CAPS]) {
    // symbol-positions-summary gives investorsHolding / totalInvested per period.
    const r = await probe(
      `sym-positions ${sym}`,
      `/stable/institutional-ownership/symbol-positions-summary?symbol=${sym}&year=2025&quarter=4`,
    );
    const holders =
      (r.sample as Record<string, unknown> | undefined)?.["investorsHolding"] ??
      (r.sample as Record<string, unknown> | undefined)?.["numberOf13Fshares"] ??
      r.count;
    symCov.push({ sym, holders: holders as number, ok: r.ok, keys: r.firstKeys });
    printResult(r);
    await gap();
  }

  // ── E. Watchlist resolvability — do all 68 CIKs resolve in FMP? ────────────
  console.log("── E. Watchlist resolvability (all 68 CIKs, light endpoint) ─────────\n");
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const f of FUNDS) {
    const r = await probe(
      `#${f.n} ${f.name}`,
      `/stable/institutional-ownership/holder-performance-summary?cik=${f.cik}&page=0`,
    );
    if (r.ok && r.count >= 1) resolved.push(`${f.name}`);
    else unresolved.push(`#${f.n} ${f.name} (${f.cik}) — ${r.kind}${r.errorMessage ? ": " + r.errorMessage.slice(0, 60) : ""}`);
    await gap(120);
  }
  console.log(`   resolved: ${resolved.length}/${FUNDS.length}`);
  if (unresolved.length) {
    console.log(`   UNRESOLVED (${unresolved.length}):`);
    for (const u of unresolved) console.log(`     - ${u}`);
  }
  console.log("");

  // ── Verdict ────────────────────────────────────────────────────────────────
  console.log("=".repeat(80));
  console.log("VERDICT");
  console.log("=".repeat(80));
  console.log(`Key valid: ${keyRes.ok ? "YES" : "NO — fix key/tier first"}`);
  console.log(`Per-fund holdings endpoint: ${winner ? winner.label : "NOT FOUND — revisit section B before building"}`);
  const conviction = winner?.firstKeys?.some((k) => valueKeys.includes(k));
  console.log(`Conviction inputs ($ value + shares per holding): ${conviction ? "YES" : "UNCONFIRMED — check winning endpoint keys"}`);
  const idJoin = winner?.firstKeys?.some((k) => ["symbol", "ticker"].includes(k));
  console.log(`Identifier join: holdings carry ${idJoin ? "SYMBOL directly (easy join)" : "CUSIP-only? (need CUSIP→ticker map — see keys above)"}`);
  const populated = depth.filter((d) => d.count > 0);
  const backfillable = populated.length >= 4;
  console.log(
    `History depth: ${populated.length}/${QUARTERS.length} probed quarters populated ` +
      `(${populated.map((d) => d.q).join(", ") || "none"}) — ${backfillable ? "backfillable ✔" : "SHALLOW — investigate"}`,
  );
  const smallOk = symCov.filter((s) => SMALL_CAPS.includes(s.sym) && s.ok && Number(s.holders) > 0);
  console.log(
    `Small/mid-cap coverage: ${smallOk.length}/${SMALL_CAPS.length} discovery names have institutional data ` +
      `(${smallOk.map((s) => `${s.sym}:${s.holders}`).join(", ") || "none"}) — ` +
      `${smallOk.length >= SMALL_CAPS.length - 1 ? "edge zone covered ✔" : "COVERAGE GAP — design finding"}`,
  );
  console.log(`Watchlist resolvable: ${resolved.length}/${FUNDS.length} CIKs known to FMP`);
  console.log("=".repeat(80));
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
