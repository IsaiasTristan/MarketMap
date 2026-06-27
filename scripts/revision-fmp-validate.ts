/**
 * Engine 1 — Phase 0 FMP validation probe (READ-ONLY).
 *
 * Validates the FMP API key/tier and the two coverage checks from the spec
 * BEFORE any schema is committed:
 *   - key validity + which datasets the plan returns,
 *   - Leg B (ratings/price-targets) history depth + granularity on a mega-cap
 *     and a genuine small-cap (the backtest foundation),
 *   - Leg A (estimates) coverage on under-followed small-caps,
 *   - earnings calendar + a usable universe source (screener),
 *   - whether bulk/batch delivery (Ultimate tier) is available.
 *
 * Makes only HTTP GETs. Writes nothing to disk or DB.
 *
 * Usage (key via argv or env, never hard-coded):
 *   npx tsx scripts/revision-fmp-validate.ts <APIKEY> [megaTicker] [smallTicker]
 *   FMP_API_KEY=... npx tsx scripts/revision-fmp-validate.ts
 */

const API_KEY = process.argv[2] || process.env.FMP_API_KEY || "";
const MEGA = (process.argv[3] || "AAPL").toUpperCase();
const SMALL = (process.argv[4] || "AXGN").toUpperCase(); // Axogen — small/under-followed
const BASE = "https://financialmodelingprep.com";

if (!API_KEY) {
  console.error(
    "No API key. Pass as first arg or set FMP_API_KEY.\n" +
      "  npx tsx scripts/revision-fmp-validate.ts <APIKEY> [mega] [small]",
  );
  process.exit(2);
}

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

function findDateRange(
  rows: Array<Record<string, unknown>>,
): { earliest: string; latest: string; field: string } | null {
  const candidates = ["date", "publishedDate", "ratingDate", "calendarDate", "acceptedDate"];
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
  const base: ProbeResult = {
    label,
    url: redact(url),
    status: 0,
    ok: false,
    kind: "error",
    count: 0,
  };
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "MarketMap/1.0 (+revision-engine-validate)" },
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
    base.ok = false;
    base.errorMessage = text.slice(0, 200);
    return base;
  }

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if (typeof obj["Error Message"] === "string") {
      base.kind = "error";
      base.ok = false;
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

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function printResult(r: ProbeResult): void {
  const head = `[${r.ok ? "OK " : "!! "}] ${r.label}  (HTTP ${r.status}, ${r.kind}, n=${r.count})`;
  console.log(head);
  console.log(`      ${r.url}`);
  if (r.errorMessage) console.log(`      error: ${r.errorMessage}`);
  if (r.dateRange)
    console.log(
      `      date field "${r.dateRange.field}": ${r.dateRange.earliest} -> ${r.dateRange.latest}`,
    );
  if (r.firstKeys) console.log(`      keys: ${r.firstKeys.join(", ")}`);
  if (r.sample !== undefined)
    console.log(`      sample: ${JSON.stringify(r.sample).slice(0, 600)}`);
  console.log("");
}

async function main() {
  const today = new Date();
  const in30 = new Date(today.getTime() + 30 * 86_400_000);
  const calFrom = fmtDate(today);
  const calTo = fmtDate(in30);

  console.log("=".repeat(78));
  console.log(`FMP Phase 0 validation — key ***${API_KEY.slice(-4)} | mega=${MEGA} small=${SMALL}`);
  console.log("=".repeat(78), "\n");

  const probes: Array<{ label: string; path: string }> = [
    // Key validity / basic
    { label: "profile (key check)", path: `/stable/profile?symbol=${MEGA}` },

    // Leg A — estimates (forward consensus) — mega + small
    { label: `LEG A estimates annual [${MEGA}]`, path: `/stable/analyst-estimates?symbol=${MEGA}&period=annual&limit=12` },
    { label: `LEG A estimates quarter [${MEGA}]`, path: `/stable/analyst-estimates?symbol=${MEGA}&period=quarter&limit=12` },
    { label: `LEG A estimates annual [${SMALL}]`, path: `/stable/analyst-estimates?symbol=${SMALL}&period=annual&limit=12` },
    { label: `LEG A estimates quarter [${SMALL}]`, path: `/stable/analyst-estimates?symbol=${SMALL}&period=quarter&limit=12` },

    // Leg B — ratings/grades event history (backtestable) — mega + small
    { label: `LEG B grades-historical [${MEGA}]`, path: `/stable/grades-historical?symbol=${MEGA}&limit=1000` },
    { label: `LEG B grades-historical [${SMALL}]`, path: `/stable/grades-historical?symbol=${SMALL}&limit=1000` },
    { label: `LEG B grades latest [${MEGA}]`, path: `/stable/grades?symbol=${MEGA}&limit=100` },
    { label: `LEG B grades-consensus [${MEGA}]`, path: `/stable/grades-consensus?symbol=${MEGA}` },

    // Leg B — price targets — mega + small
    { label: `LEG B price-target-summary [${MEGA}]`, path: `/stable/price-target-summary?symbol=${MEGA}` },
    { label: `LEG B price-target-summary [${SMALL}]`, path: `/stable/price-target-summary?symbol=${SMALL}` },
    { label: `LEG B price-target-consensus [${MEGA}]`, path: `/stable/price-target-consensus?symbol=${MEGA}` },
    { label: `LEG B price-target-news [${MEGA}]`, path: `/stable/price-target-news?symbol=${MEGA}&limit=100` },

    // Earnings calendar (proximity weighting)
    { label: "earnings-calendar (next 30d)", path: `/stable/earnings-calendar?from=${calFrom}&to=${calTo}` },

    // Universe source
    { label: "company-screener (universe)", path: `/stable/company-screener?marketCapMoreThan=300000000&exchange=NASDAQ&isActivelyTrading=true&limit=20` },

    // Tier detection — bulk delivery (Ultimate)
    { label: "TIER bulk grades", path: `/stable/grades-bulk?part=0` },
    { label: "TIER bulk price-target-summary", path: `/stable/price-target-summary-bulk?part=0` },
    { label: "TIER upgrades-downgrades-consensus-bulk", path: `/stable/upgrades-downgrades-consensus-bulk?part=0` },
  ];

  const results: ProbeResult[] = [];
  for (const p of probes) {
    const r = await probe(p.label, p.path);
    printResult(r);
    results.push(r);
    await new Promise((res) => setTimeout(res, 200)); // politeness gap
  }

  // ---- Verdict ----
  console.log("=".repeat(78));
  console.log("VERDICT");
  console.log("=".repeat(78));

  const byLabel = (s: string) => results.find((r) => r.label.startsWith(s));
  const keyOk = byLabel("profile")?.ok ?? false;
  console.log(`Key valid: ${keyOk ? "YES" : "NO"}${keyOk ? "" : " — fix the key/tier before anything else"}`);

  const legAMega = results.find((r) => r.label.includes("estimates annual [" + MEGA));
  const legASmall = results.find((r) => r.label.includes("estimates annual [" + SMALL));
  console.log(
    `Leg A coverage: mega=${legAMega?.count ?? 0} rows, small=${legASmall?.count ?? 0} rows ` +
      `(small-cap populated: ${(legASmall?.count ?? 0) > 0 ? "YES" : "NO"})`,
  );

  const legBMega = results.find((r) => r.label.includes("grades-historical [" + MEGA));
  const legBSmall = results.find((r) => r.label.includes("grades-historical [" + SMALL));
  console.log(
    `Leg B grades history: mega=${legBMega?.count ?? 0} events ${legBMega?.dateRange ? `(${legBMega.dateRange.earliest}->${legBMega.dateRange.latest})` : ""}; ` +
      `small=${legBSmall?.count ?? 0} events ${legBSmall?.dateRange ? `(${legBSmall.dateRange.earliest}->${legBSmall.dateRange.latest})` : ""}`,
  );

  const ptNews = byLabel(`LEG B price-target-news`);
  console.log(
    `Leg B price-target event history available: ${ptNews?.ok && (ptNews?.count ?? 0) > 0 ? "YES (event-level)" : "NO — PT history must accrue via weekly snapshots"}`,
  );

  const screener = byLabel("company-screener");
  console.log(`Universe source (screener) works: ${screener?.ok ? "YES" : "NO"}`);

  const bulkAny = results.filter((r) => r.label.startsWith("TIER")).some((r) => r.ok);
  console.log(
    `Tier: ${bulkAny ? "ULTIMATE (bulk/batch available — fast backfill + weekly pull)" : "PREMIUM or lower (no bulk — use per-symbol worker pool)"}`,
  );
  console.log("=".repeat(78));
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
