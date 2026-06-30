/**
 * Pure quality filter for the portfolio news feed. No I/O. Drops low-signal
 * articles before ranking using four gates:
 *   1. preview present (non-trivial text),
 *   2. relevance (the holding's company-name token or exact ticker appears),
 *   3. reputable-publisher allowlist (press releases bypass this gate),
 *   4. clickbait-title denylist.
 *
 * Constants are exported plain arrays so they are trivial to tune.
 */
import type { NewsArticle } from "./rank-news";

const MIN_PREVIEW_LENGTH = 40;

/**
 * Reputable outlets we keep. Matched against both `site` and `publisher`
 * (normalized). Official PR wires are included so company releases that flow
 * through the regular news feed still pass; press-release-sourced items bypass
 * this list entirely.
 */
export const NEWS_PUBLISHER_ALLOWLIST: string[] = [
  "reuters.com",
  "bloomberg.com",
  "cnbc.com",
  "wsj.com",
  "barrons.com",
  "marketwatch.com",
  "forbes.com",
  "ft.com",
  "seekingalpha.com",
  "investors.com",
  "thestreet.com",
  "fool.com",
  "investorplace.com",
  "businessinsider.com",
  "yahoo.com",
  "apnews.com",
  "axios.com",
  "nytimes.com",
  // official company press-release wires
  "prnewswire.com",
  "globenewswire.com",
  "businesswire.com",
  "accesswire.com",
  "newsfilecorp.com",
  "prnewswire",
  "globenewswire",
  "business wire",
  "accesswire",
];

/** Clickbait / templated-list title patterns dropped even from allowlisted sources. */
export const NEWS_TITLE_DENYLIST: RegExp[] = [
  /\b(soars?|surges?|jumps?|plunges?|rallies|tumbles?|sinks?|spikes?)\b.*\d+(\.\d+)?%/i,
  /is\s+(further\s+)?upside\s+left/i,
  /^top\s+\d+\b/i,
  /\bmagic formula\b/i,
  /\bbull of the day\b/i,
  /\bbear of the day\b/i,
  /\bzacks rank\b/i,
  /\bare\b.*\bstocks\b.*\b(lagging|leading|outperforming|underperforming)\b/i,
  /\b\d+\s+(attractive|best|top|cheap|hot|must|great)\b.*\bstocks?\b/i,
  /which etf is the better buy/i,
  /stack up for retirement/i,
  /\bgf value\b/i,
  /\bovervalued\b.*\b(after|rally)\b/i,
];

const COMPANY_STOPWORDS = new Set([
  "the",
  "inc",
  "inc.",
  "corp",
  "corp.",
  "corporation",
  "co",
  "co.",
  "company",
  "ltd",
  "ltd.",
  "llc",
  "plc",
  "lp",
  "holdings",
  "holding",
  "group",
  "groupe",
  "software",
  "interactive",
  "technologies",
  "technology",
  "therapeutics",
  "pharmaceuticals",
  "pharmaceutical",
  "pharma",
  "healthcare",
  "biosciences",
  "biotechnologies",
  "systems",
  "solutions",
  "international",
  "industries",
  "enterprises",
  "&",
  "and",
  "de",
]);

/** Generic leading words that are too common to match on alone. */
const GENERIC_LEADING = new Set([
  "national",
  "general",
  "american",
  "united",
  "global",
  "first",
  "new",
  "north",
  "south",
  "western",
  "eastern",
  "central",
  "public",
  "premier",
]);

/**
 * Derive a lowercase company match phrase from a display name. Returns the first
 * meaningful word, or the first two words when the leading word is generic.
 * Empty string when nothing usable remains (caller falls back to the ticker).
 */
export function deriveCompanyTokens(name: string): string {
  const beforeComma = name.split(",")[0] ?? name;
  const words = beforeComma
    .toLowerCase()
    .replace(/[^a-z0-9&.\-\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !COMPANY_STOPWORDS.has(w));
  if (words.length === 0) return "";
  const first = words[0]!;
  if (GENERIC_LEADING.has(first) && words.length >= 2) {
    return `${first} ${words[1]}`;
  }
  return first;
}

function normalizeSource(s: string | null): string {
  return (s ?? "").toLowerCase().trim();
}

function isAllowlistedSource(article: NewsArticle): boolean {
  const site = normalizeSource(article.site);
  const publisher = normalizeSource(article.publisher);
  return NEWS_PUBLISHER_ALLOWLIST.some(
    (allowed) => site.includes(allowed) || publisher.includes(allowed),
  );
}

function isClickbaitTitle(title: string): boolean {
  return NEWS_TITLE_DENYLIST.some((re) => re.test(title));
}

function wholeWordTicker(ticker: string): RegExp {
  const escaped = ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`);
}

function isRelevant(article: NewsArticle, companyName: string): boolean {
  const haystack = `${article.title} ${article.text ?? ""}`;
  const token = deriveCompanyTokens(companyName);
  if (token.length >= 3 && haystack.toLowerCase().includes(token)) return true;
  // Fallback to an exact, case-sensitive whole-word ticker match only when the
  // company token is too short/generic to be reliable.
  if (token.length < 3) {
    return wholeWordTicker(article.ticker).test(haystack);
  }
  return false;
}

/**
 * Filter raw articles to the high-signal set. `nameByTicker` supplies the
 * company name used for the relevance check. Press-release items
 * (`isPressRelease`) skip the publisher allowlist (trusted by source).
 */
export function filterNewsArticles(
  articles: NewsArticle[],
  nameByTicker: Map<string, string>,
): NewsArticle[] {
  return articles.filter((a) => {
    const ticker = a.ticker.toUpperCase();
    const companyName = nameByTicker.get(ticker);
    if (!companyName) return false;

    const preview = (a.text ?? "").trim();
    if (preview.length < MIN_PREVIEW_LENGTH) return false;

    if (isClickbaitTitle(a.title)) return false;
    if (!isRelevant(a, companyName)) return false;
    if (!a.isPressRelease && !isAllowlistedSource(a)) return false;

    return true;
  });
}
