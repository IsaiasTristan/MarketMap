/**
 * Pure gate for the brokerage-sync background runner.
 *
 * Brokerage holdings settle after the market close, so a once-per-day sync run
 * shortly after the close is the right cadence. `isBrokerageSyncDue` returns
 * true at most once per US-Eastern calendar day, only after 16:30 ET, mirroring
 * the pure-gate style of the Engine-2/3 runners (`isNewSettledQuarter`,
 * `isLateFilerRefreshDue`). The manual "Sync now" button bypasses this gate.
 *
 * Clock-only (no holiday calendar): a weekend/holiday run is harmless — the
 * holdings are unchanged and the sync is cheap — and keeps the gate a pure
 * function of the timestamp, testable across DST.
 */

/** Minutes since ET midnight after which a daily sync is allowed (16:30). */
const POST_CLOSE_GATE_MIN = 16 * 60 + 30;

interface EtParts {
  /** yyyy-MM-dd in US Eastern. */
  date: string;
  /** Minutes since ET midnight. */
  minutes: number;
}

function etParts(d: Date): EtParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { date: `${year}-${month}-${day}`, minutes: hour * 60 + minute };
}

/**
 * True when a daily brokerage sync should run: it is at/after 16:30 ET and the
 * last successful sync (if any) was on an earlier ET calendar day.
 */
export function isBrokerageSyncDue(lastSyncAt: Date | null, now: Date): boolean {
  const nowEt = etParts(now);
  if (nowEt.minutes < POST_CLOSE_GATE_MIN) return false;
  if (lastSyncAt === null) return true;
  return etParts(lastSyncAt).date !== nowEt.date;
}
