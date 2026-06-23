/**
 * US equity market session state machine.
 *
 * Four-state classifier derived from US Eastern Time:
 *   - PRE     : pre-market    [04:00, 09:30) ET on weekdays
 *   - REGULAR : regular hours [09:30, 16:00) ET on weekdays
 *   - POST    : after-hours   [16:00, 20:00) ET on weekdays
 *   - CLOSED  : everything else (overnight gap, weekends)
 *
 * Used by:
 *   - The Performance top-bar to render the status label + colour and decide
 *     whether to show the "revert to close" / "show after-hours" toggle.
 *   - The server-side extended-hours sweep runner to decide whether to issue
 *     a sweep at all (only PRE / POST are eligible — REGULAR is already
 *     covered by the daily tail-ingest path that persists today's partial
 *     bar to PriceHistory; CLOSED means no fresh extended prints to harvest).
 *
 * Holidays: This is a pure clock heuristic — it does NOT consult a US equity
 * holiday calendar. On a market holiday the label may still read PRE /
 * REGULAR / POST, but the downstream overlay degrades gracefully because
 * Yahoo returns no fresh extended bars on those days, so the cached
 * snapshot stays empty and the grid simply falls back to close-based values.
 */

export type MarketSession = "PRE" | "REGULAR" | "POST" | "CLOSED";

/** Minutes since midnight ET for each session boundary. */
const PRE_START_MIN = 4 * 60; // 04:00
const REGULAR_START_MIN = 9 * 60 + 30; // 09:30
const REGULAR_CLOSE_MIN = 16 * 60; // 16:00
const POST_CLOSE_MIN = 20 * 60; // 20:00

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

/**
 * Classify `now` into the four-state US market session. Pure function — the
 * only external dependency is `Intl.DateTimeFormat` for the America/New_York
 * timezone, which is available in both Node and browser runtimes.
 */
export function getUsMarketSession(now: Date): MarketSession {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hourRaw = parts.find((p) => p.type === "hour")?.value ?? "0";
  // Intl returns "24" at midnight on some platforms; normalise to 0.
  const hour = Number(hourRaw) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const minutesInDay = hour * 60 + minute;

  if (!WEEKDAYS.has(weekday)) return "CLOSED";
  if (minutesInDay < PRE_START_MIN) return "CLOSED";
  if (minutesInDay < REGULAR_START_MIN) return "PRE";
  if (minutesInDay < REGULAR_CLOSE_MIN) return "REGULAR";
  if (minutesInDay < POST_CLOSE_MIN) return "POST";
  return "CLOSED";
}

/** True iff this session is one of the two extended-hours windows. */
export function isExtendedSession(s: MarketSession): boolean {
  return s === "PRE" || s === "POST";
}

/**
 * Day-of-week-agnostic classifier for an arbitrary epoch in *seconds*. Returns
 * the session window that contains the timestamp's ET time-of-day:
 *
 *   - PRE     : 04:00 ≤ ET < 09:30
 *   - REGULAR : 09:30 ≤ ET < 16:00
 *   - POST    : 16:00 ≤ ET < 20:00
 *   - REGULAR : everything else (overnight 20:00–04:00). Returned as REGULAR
 *               instead of a separate CLOSED state because callers use this to
 *               decide whether an extended-hours bar is *usable*; overnight
 *               bars don't exist for US equities, and surfacing them as
 *               REGULAR causes the sweep to drop them just like a normal
 *               regular-session bar.
 *
 * Used by `parseYahooExtendedQuote` as a fallback when Yahoo's
 * `currentTradingPeriod` windows describe today but the bar landed on a
 * prior day (e.g. a weekend backfill query reaching back to Friday's POST).
 */
/** Calendar date (yyyy-MM-dd) in US Eastern for an epoch-seconds timestamp. */
export function tradeDateEtFromUnix(unixSeconds: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

export function classifyEtTimeOfDay(
  unixSeconds: number,
): "PRE" | "REGULAR" | "POST" {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(unixSeconds * 1000));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const m = hour * 60 + minute;
  if (m >= PRE_START_MIN && m < REGULAR_START_MIN) return "PRE";
  if (m >= REGULAR_START_MIN && m < REGULAR_CLOSE_MIN) return "REGULAR";
  if (m >= REGULAR_CLOSE_MIN && m < POST_CLOSE_MIN) return "POST";
  return "REGULAR";
}
