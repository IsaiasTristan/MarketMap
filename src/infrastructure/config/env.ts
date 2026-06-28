function readNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Annualized risk-free rate as decimal (e.g. 0.04). */
export function riskFreeAnnual(): number {
  return readNumber("RISK_FREE_ANNUAL", 0.04);
}

export function marketDataProviderId(): string {
  return process.env.MARKET_DATA_PROVIDER ?? "yahoo";
}

// ─── FMP (Financial Modeling Prep) — Engine 1 revision detector ────────────

/** FMP API key. Empty string when unset (callers should fail loudly). */
export function fmpApiKey(): string {
  return process.env.FMP_API_KEY?.trim() ?? "";
}

/** FMP REST base URL (no trailing slash). */
export function fmpBaseUrl(): string {
  const v = process.env.FMP_BASE_URL?.trim();
  return v && v.length ? v.replace(/\/$/, "") : "https://financialmodelingprep.com";
}

/**
 * Plan tier hint, lower-cased. "ultimate" enables the bulk-CSV ingestion path;
 * anything else falls back to the per-symbol worker pool. Validated key is
 * Ultimate-class (bulk endpoints return data), so default to "ultimate".
 */
export function fmpTier(): "ultimate" | "premium" {
  return process.env.FMP_TIER?.trim().toLowerCase() === "premium" ? "premium" : "ultimate";
}

/** Max FMP calls per minute (politeness budget). Premium 750, Ultimate 3000. */
export function fmpCallsPerMinute(): number {
  return readNumber("FMP_CALLS_PER_MINUTE", fmpTier() === "premium" ? 700 : 2800);
}

// ─── Cloudflare Access identity / admin role ──────────────────────────────

/**
 * Cloudflare Access team domain, e.g. "it-projects33.cloudflareaccess.com".
 * Used to fetch the public signing keys (`/cdn-cgi/access/certs`) that verify
 * the `Cf-Access-Jwt-Assertion` token. Null when unset (e.g. local dev).
 */
export function cfAccessTeamDomain(): string | null {
  const v = process.env.CF_ACCESS_TEAM_DOMAIN;
  return v && v.trim() ? v.trim().replace(/^https?:\/\//, "").replace(/\/$/, "") : null;
}

/**
 * Cloudflare Access application AUD tag (from the Zero Trust dashboard ->
 * Access -> Applications -> your app -> Overview). When set, the JWT's
 * audience is validated against it. Null when unset (signature/issuer are
 * still verified, audience check is skipped with a warning).
 */
export function cfAccessAud(): string | null {
  const v = process.env.CF_ACCESS_AUD;
  return v && v.trim() ? v.trim() : null;
}

/**
 * Admin email allow-list. Defaults to the single product admin. Everyone else
 * who authenticates becomes a normal USER. Comparison is case-insensitive.
 */
export function adminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS ?? "isaiastristan@live.com";
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
