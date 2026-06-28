/**
 * Engine 2 — Phase 0 FMP fundamentals validation probe (READ-ONLY).
 *
 * Verify-before-trust, BEFORE any schema is committed:
 *   - income / balance / cash-flow statement coverage + history depth on a
 *     mega-cap and several genuine small-caps,
 *   - **OCF + capex coverage on small-caps specifically** (the accruals
 *     trap-detector dies silently if cash-flow-statement coverage thins on the
 *     small names — this is the highest-value check here),
 *   - ratios + key-metrics availability,
 *   - reconciliation of FMP's pre-computed grossMargin / ebitdaMargin / ROIC /
 *     EV / EV-EBITDA against our own formulas computed from the line items, to
 *     decide per metric: store-FMP vs compute-our-own.
 *
 * Makes only HTTP GETs. Writes nothing to disk or DB.
 *
 * Usage (key via argv or env, never hard-coded):
 *   npx tsx scripts/fundamental-fmp-validate.ts <APIKEY> [megaTicker] [small1,small2,...]
 *   FMP_API_KEY=... npx tsx scripts/fundamental-fmp-validate.ts
 */
export {}; // module scope (avoids global-scope collision with other CLI probes)

const API_KEY = process.argv[2] || process.env.FMP_API_KEY || "";
const MEGA = (process.argv[3] || "AAPL").toUpperCase();
const SMALLS = (process.argv[4] || "AXGN,KOPN,GERN,EVH")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const BASE = "https://financialmodelingprep.com";
const PERIOD = "quarter";
const LIMIT = 32; // ~8 years quarterly

if (!API_KEY) {
  console.error(
    "No API key. Pass as first arg or set FMP_API_KEY.\n" +
      "  npx tsx scripts/fundamental-fmp-validate.ts <APIKEY> [mega] [small1,small2,...]",
  );
  process.exit(2);
}

function withKey(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${BASE}${path}${sep}apikey=${API_KEY}`;
}
function redact(url: string): string {
  return url.replace(/apikey=[^&]+/, "apikey=***");
}

type Row = Record<string, unknown>;

async function getJson(path: string): Promise<{ status: number; rows: Row[]; error?: string }> {
  const url = withKey(path);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "MarketMap/1.0 (+fundamental-validate)" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { status: 0, rows: [], error: e instanceof Error ? e.message : String(e) };
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: res.status, rows: [], error: `non-json: ${text.slice(0, 160)}` };
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const msg = (body as Row)["Error Message"];
    if (typeof msg === "string") return { status: res.status, rows: [], error: msg };
    return { status: res.status, rows: [body as Row] };
  }
  return { status: res.status, rows: Array.isArray(body) ? (body as Row[]) : [] };
}

function n(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}
function pct(a: number | null, b: number | null): string {
  if (a === null || b === null || b === 0) return "n/a";
  return `${(((a - b) / Math.abs(b)) * 100).toFixed(1)}%`;
}
function coverageCount(rows: Row[], field: string): number {
  return rows.filter((r) => n(r[field]) !== null).length;
}
function dateRange(rows: Row[]): string {
  const dates = rows
    .map((r) => r["date"])
    .filter((d): d is string => typeof d === "string")
    .sort();
  return dates.length ? `${dates[0]} -> ${dates[dates.length - 1]}` : "—";
}

interface SymbolReport {
  ticker: string;
  income: number;
  balance: number;
  cash: number;
  ratios: number;
  keyMetrics: number;
  ocfCoverage: string; // present/total
  capexCoverage: string;
  range: string;
}

async function reportSymbol(ticker: string): Promise<SymbolReport> {
  const [inc, bal, cf, rat, km] = await Promise.all([
    getJson(`/stable/income-statement?symbol=${ticker}&period=${PERIOD}&limit=${LIMIT}`),
    getJson(`/stable/balance-sheet-statement?symbol=${ticker}&period=${PERIOD}&limit=${LIMIT}`),
    getJson(`/stable/cash-flow-statement?symbol=${ticker}&period=${PERIOD}&limit=${LIMIT}`),
    getJson(`/stable/ratios?symbol=${ticker}&period=${PERIOD}&limit=${LIMIT}`),
    getJson(`/stable/key-metrics?symbol=${ticker}&period=${PERIOD}&limit=${LIMIT}`),
  ]);
  const cfRows = cf.rows;
  const ocfPresent =
    coverageCount(cfRows, "operatingCashFlow") ||
    coverageCount(cfRows, "netCashProvidedByOperatingActivities");
  const capexPresent = coverageCount(cfRows, "capitalExpenditure");
  return {
    ticker,
    income: inc.rows.length,
    balance: bal.rows.length,
    cash: cfRows.length,
    ratios: rat.rows.length,
    keyMetrics: km.rows.length,
    ocfCoverage: `${ocfPresent}/${cfRows.length}`,
    capexCoverage: `${capexPresent}/${cfRows.length}`,
    range: dateRange(inc.rows),
  };
}

async function reconcile(ticker: string): Promise<void> {
  const [inc, bal, cf, rat, km] = await Promise.all([
    getJson(`/stable/income-statement?symbol=${ticker}&period=${PERIOD}&limit=4`),
    getJson(`/stable/balance-sheet-statement?symbol=${ticker}&period=${PERIOD}&limit=4`),
    getJson(`/stable/cash-flow-statement?symbol=${ticker}&period=${PERIOD}&limit=4`),
    getJson(`/stable/ratios?symbol=${ticker}&period=${PERIOD}&limit=4`),
    getJson(`/stable/key-metrics?symbol=${ticker}&period=${PERIOD}&limit=4`),
  ]);
  const i = inc.rows[0];
  const b = bal.rows[0];
  const c = cf.rows[0];
  const r = rat.rows[0];
  const k = km.rows[0];
  if (!i) {
    console.log(`  [${ticker}] no income rows to reconcile`);
    return;
  }
  console.log(`  [${ticker}] latest fiscal date ${i["date"]}`);

  // Gross margin
  const revenue = n(i["revenue"]);
  const grossProfit = n(i["grossProfit"]);
  const oursGm = revenue && grossProfit !== null ? grossProfit / revenue : null;
  const fmpGm = n(r?.["grossProfitMargin"]);
  console.log(`    grossMargin  ours=${oursGm?.toFixed(4) ?? "n/a"}  fmp=${fmpGm?.toFixed(4) ?? "n/a"}  diff=${pct(fmpGm, oursGm)}`);

  // EBITDA margin (ours: (operatingIncome + D&A)/revenue)
  const opInc = n(i["operatingIncome"]);
  const da = n(i["depreciationAndAmortization"]) ?? n(c?.["depreciationAndAmortization"]);
  const oursEbitda = opInc !== null && da !== null ? opInc + da : null;
  const oursEbitdaM = oursEbitda !== null && revenue ? oursEbitda / revenue : null;
  const fmpEbitda = n(i["ebitda"]);
  const fmpEbitdaM = n(r?.["ebitdaMargin"]);
  console.log(
    `    ebitda       ours(opInc+D&A)=${oursEbitda?.toFixed(0) ?? "n/a"}  fmp=${fmpEbitda?.toFixed(0) ?? "n/a"}  diff=${pct(fmpEbitda, oursEbitda)}`,
  );
  console.log(`    ebitdaMargin ours=${oursEbitdaM?.toFixed(4) ?? "n/a"}  fmp=${fmpEbitdaM?.toFixed(4) ?? "n/a"}  diff=${pct(fmpEbitdaM, oursEbitdaM)}`);

  // FCF (ours: OCF + capex, capex stored negative)
  const ocf = n(c?.["operatingCashFlow"]) ?? n(c?.["netCashProvidedByOperatingActivities"]);
  const capex = n(c?.["capitalExpenditure"]);
  const oursFcf = ocf !== null && capex !== null ? ocf + capex : null;
  const fmpFcf = n(c?.["freeCashFlow"]);
  console.log(`    freeCashFlow ours(OCF+capex)=${oursFcf?.toFixed(0) ?? "n/a"}  fmp=${fmpFcf?.toFixed(0) ?? "n/a"}  diff=${pct(fmpFcf, oursFcf)}`);

  // EV (ours: marketCap + totalDebt - cash)
  const mc = n(k?.["marketCap"]);
  const totalDebt = n(b?.["totalDebt"]);
  const cash = n(b?.["cashAndCashEquivalents"]) ?? n(b?.["cashAndShortTermInvestments"]);
  const oursEv = mc !== null && totalDebt !== null && cash !== null ? mc + totalDebt - cash : null;
  const fmpEv = n(k?.["enterpriseValue"]);
  console.log(`    enterpriseValue ours=${oursEv?.toFixed(0) ?? "n/a"}  fmp=${fmpEv?.toFixed(0) ?? "n/a"}  diff=${pct(fmpEv, oursEv)}`);

  // ROIC (FMP only — flag presence)
  const fmpRoic = n(r?.["returnOnInvestedCapital"]) ?? n(k?.["returnOnInvestedCapital"]);
  console.log(`    roic (FMP)   ${fmpRoic?.toFixed(4) ?? "n/a"}  (no clean one-line our-formula; trust FMP if present, else compute NOPAT/IC)`);
}

async function main() {
  console.log("=".repeat(80));
  console.log(`Engine 2 FMP fundamentals validation — key ***${API_KEY.slice(-4)}`);
  console.log(`mega=${MEGA}  smalls=${SMALLS.join(", ")}  period=${PERIOD}  limit=${LIMIT}`);
  console.log("=".repeat(80), "\n");

  const reports: SymbolReport[] = [];
  for (const t of [MEGA, ...SMALLS]) {
    reports.push(await reportSymbol(t));
    await new Promise((res) => setTimeout(res, 200));
  }

  console.log("COVERAGE (rows returned per endpoint; OCF/capex = present/total cash-flow rows)\n");
  console.log(
    ["ticker", "inc", "bal", "cash", "ratios", "keyM", "OCF cov", "capex cov", "income range"]
      .map((h) => h.padEnd(h === "income range" ? 24 : 9))
      .join(""),
  );
  for (const r of reports) {
    console.log(
      [
        r.ticker.padEnd(9),
        String(r.income).padEnd(9),
        String(r.balance).padEnd(9),
        String(r.cash).padEnd(9),
        String(r.ratios).padEnd(9),
        String(r.keyMetrics).padEnd(9),
        r.ocfCoverage.padEnd(9),
        r.capexCoverage.padEnd(9),
        r.range,
      ].join(""),
    );
  }

  console.log("\n" + "=".repeat(80));
  console.log("RATIO RECONCILIATION (ours vs FMP — decides store-FMP vs compute-our-own)");
  console.log("=".repeat(80));
  for (const t of [MEGA, ...SMALLS]) {
    await reconcile(t);
    await new Promise((res) => setTimeout(res, 200));
  }

  console.log("\n" + "=".repeat(80));
  console.log("VERDICT");
  console.log("=".repeat(80));
  const small = reports.filter((r) => r.ticker !== MEGA);
  const allHaveStatements = reports.every((r) => r.income > 0 && r.balance > 0 && r.cash > 0);
  console.log(`Statements present for every probed name: ${allHaveStatements ? "YES" : "NO"}`);
  const accrualsOk = small.every((r) => {
    const [ocf] = r.ocfCoverage.split("/").map(Number);
    const [cap] = r.capexCoverage.split("/").map(Number);
    return (ocf ?? 0) > 0 && (cap ?? 0) > 0;
  });
  console.log(
    `Accruals inputs (OCF + capex) present on ALL small-caps: ${accrualsOk ? "YES" : "NO — accruals signal will degrade to null on uncovered small names"}`,
  );
  console.log(
    "Next: use the reconciliation diffs above to set, per metric, whether the ingestion stores\n" +
      "FMP's pre-computed value or recomputes from line items (small constant diffs => trust FMP;\n" +
      "large/structural diffs => compute our own). Derived EBITDA/EV/FCF/accruals are always stored\n" +
      "(point-in-time integrity). Backfill is restated-basis; true point-in-time accrues forward.",
  );
  console.log("=".repeat(80));
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
