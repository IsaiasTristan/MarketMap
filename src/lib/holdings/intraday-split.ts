import { todayEtIsoDate } from "@/lib/factors/attribution/today-et";
import {
  classifyEtTimeOfDay,
  getUsMarketSession,
  tradeDateEtFromUnix,
} from "@/lib/market-map/market-session";

export const SPARKLINE_MAX_POINTS = 80;
const REGULAR_SPARKLINE_MAX = 60;
const EXTENDED_SPARKLINE_MAX = 20;

const MIN_SESSION_BARS = 2;

export type IntradaySessionSplit = {
  byDateRegular: Map<string, number[]>;
  byDatePre: Map<string, number[]>;
  byDatePost: Map<string, number[]>;
};

/** One timestamped intraday bar, tagged regular vs extended (PRE/POST). */
export type TodaySessionPoint = {
  /** ISO datetime of the bar. */
  t: string;
  price: number;
  session: "regular" | "extended";
};

/** Max points kept for a tile's full-day (pre+regular+post) series. */
const TODAY_POINTS_MAX = 96;

/** Decimate by stride, preserving first and last samples. */
export function decimateSparkline(arr: number[], maxLen: number): number[] {
  if (arr.length <= maxLen) return arr;
  const stride = Math.ceil(arr.length / maxLen);
  const out: number[] = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]!);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]!);
  return out;
}

/** Decimate an array of objects by stride, always preserving first and last. */
function decimatePoints<T>(arr: T[], maxLen: number): T[] {
  if (arr.length <= maxLen) return arr;
  const stride = Math.ceil(arr.length / maxLen);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]!);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]!);
  return out;
}

function finiteCloses(closes: (number | null)[]): number[] {
  return closes.filter((c): c is number => c != null && Number.isFinite(c));
}

function pushBucket(map: Map<string, number[]>, key: string, value: number) {
  const bucket = map.get(key) ?? [];
  bucket.push(value);
  map.set(key, bucket);
}

/**
 * Group intraday bars by ET date and session (REGULAR vs PRE/POST).
 */
export function splitIntradaySessions(
  timestamps: number[],
  closes: (number | null)[],
): IntradaySessionSplit {
  const byDateRegular = new Map<string, number[]>();
  const byDatePre = new Map<string, number[]>();
  const byDatePost = new Map<string, number[]>();

  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) continue;
    const unix = timestamps[i]!;
    const d = tradeDateEtFromUnix(unix);
    const session = classifyEtTimeOfDay(unix);
    if (session === "REGULAR") {
      pushBucket(byDateRegular, d, c);
    } else if (session === "PRE") {
      pushBucket(byDatePre, d, c);
    } else {
      pushBucket(byDatePost, d, c);
    }
  }

  return { byDateRegular, byDatePre, byDatePost };
}

function latestPriorRegularDate(
  byDateRegular: Map<string, number[]>,
  todayEt: string,
): string | null {
  const priorDates = [...byDateRegular.keys()].filter((d) => d < todayEt).sort();
  for (let i = priorDates.length - 1; i >= 0; i--) {
    const d = priorDates[i]!;
    if ((byDateRegular.get(d)?.length ?? 0) >= MIN_SESSION_BARS) return d;
  }
  return null;
}

/**
 * Compose the Current Price sparkline: regular session (bicolor) plus optional
 * extended PRE/POST tail (dashed gray in the UI).
 *
 * The dashed tail only ever represents price action that comes AFTER the solid
 * regular line:
 *   - During / after today's regular session, the tail is today's POST bars
 *     (empty until 16:00 ET) — never this morning's PRE bars, which belong
 *     before the open and would render backwards.
 *   - Before today's open (carry branch), the solid line is the prior regular
 *     session and the tail is that session's POST bars, plus this morning's
 *     PRE bars while the clock is in the PRE window.
 */
export function composeCurrentSparkline(
  sessions: IntradaySessionSplit,
  now: Date = new Date(),
): { regular: number[]; extended: number[] } {
  const todayEt = todayEtIsoDate(now);
  const clockSession = getUsMarketSession(now);

  const todayRegular = sessions.byDateRegular.get(todayEt) ?? [];
  if (todayRegular.length >= MIN_SESSION_BARS) {
    return {
      regular: decimateSparkline(todayRegular, REGULAR_SPARKLINE_MAX),
      extended: decimateSparkline(
        sessions.byDatePost.get(todayEt) ?? [],
        EXTENDED_SPARKLINE_MAX,
      ),
    };
  }

  const carryDate = latestPriorRegularDate(sessions.byDateRegular, todayEt);
  if (carryDate) {
    let extended = [...(sessions.byDatePost.get(carryDate) ?? [])];
    if (clockSession === "PRE") {
      extended = [...extended, ...(sessions.byDatePre.get(todayEt) ?? [])];
    }
    return {
      regular: decimateSparkline(
        sessions.byDateRegular.get(carryDate) ?? [],
        REGULAR_SPARKLINE_MAX,
      ),
      extended: decimateSparkline(extended, EXTENDED_SPARKLINE_MAX),
    };
  }

  const todayExtended = [
    ...(sessions.byDatePre.get(todayEt) ?? []),
    ...(sessions.byDatePost.get(todayEt) ?? []),
  ];
  if (todayExtended.length >= MIN_SESSION_BARS) {
    return { regular: [], extended: decimateSparkline(todayExtended, EXTENDED_SPARKLINE_MAX) };
  }

  return { regular: [], extended: [] };
}

/**
 * Build today's full pre -> regular -> post intraday series as timestamped
 * points for the Live Prices tiles. Unlike {@link composeCurrentSparkline}
 * (which keeps only the POST tail after the open and renders by index), this
 * preserves every session in chronological order with real timestamps so the
 * tile can place pre-market before the open and post-market after the close on
 * an accurate ET time axis.
 *
 * Falls back to the most recent prior trading day when today has no bars yet
 * (weekend / holiday / pre-open before the first print) so a tile is never
 * blank when recent data exists.
 */
export function composeTodaySessionPoints(
  timestamps: number[],
  closes: (number | null)[],
  now: Date = new Date(),
): TodaySessionPoint[] {
  type RawBar = { unix: number; price: number; session: "regular" | "extended" };
  const byDate = new Map<string, RawBar[]>();
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) continue;
    const unix = timestamps[i]!;
    const d = tradeDateEtFromUnix(unix);
    const session =
      classifyEtTimeOfDay(unix) === "REGULAR" ? "regular" : "extended";
    const bucket = byDate.get(d) ?? [];
    bucket.push({ unix, price: c, session });
    byDate.set(d, bucket);
  }

  const todayEt = todayEtIsoDate(now);
  let targetDate: string | null = byDate.has(todayEt) ? todayEt : null;
  if (!targetDate) {
    const priorDates = [...byDate.keys()].filter((d) => d < todayEt).sort();
    for (let i = priorDates.length - 1; i >= 0; i--) {
      if ((byDate.get(priorDates[i]!)?.length ?? 0) >= MIN_SESSION_BARS) {
        targetDate = priorDates[i]!;
        break;
      }
    }
  }
  if (!targetDate) return [];

  const bars = (byDate.get(targetDate) ?? [])
    .slice()
    .sort((a, b) => a.unix - b.unix);

  return decimatePoints(bars, TODAY_POINTS_MAX).map((b) => ({
    t: new Date(b.unix * 1000).toISOString(),
    price: b.price,
    session: b.session,
  }));
}

/**
 * Split a Yahoo intraday bar series into today's session and the prior
 * trading session (regular-hours bars only, by US Eastern calendar date).
 */
export function splitIntradayByEtDate(
  timestamps: number[],
  closes: (number | null)[],
  now: Date = new Date(),
): { todayCloses: number[]; prevDayCloses: number[] } {
  if (timestamps.length === 0) {
    const all = finiteCloses(closes);
    if (all.length >= MIN_SESSION_BARS) {
      return {
        todayCloses: decimateSparkline(all, SPARKLINE_MAX_POINTS),
        prevDayCloses: [],
      };
    }
    return { todayCloses: [], prevDayCloses: [] };
  }

  const sessions = splitIntradaySessions(timestamps, closes);
  const todayEt = todayEtIsoDate(now);
  const todayRaw = sessions.byDateRegular.get(todayEt) ?? [];
  const prevDate = latestPriorRegularDate(sessions.byDateRegular, todayEt);

  return {
    todayCloses: decimateSparkline(todayRaw, SPARKLINE_MAX_POINTS),
    prevDayCloses: decimateSparkline(
      prevDate ? (sessions.byDateRegular.get(prevDate) ?? []) : [],
      SPARKLINE_MAX_POINTS,
    ),
  };
}

/** All finite intraday closes grouped by US Eastern calendar date (any session). */
function byDateAllCloses(
  timestamps: number[],
  closes: (number | null)[],
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) continue;
    pushBucket(map, tradeDateEtFromUnix(timestamps[i]!), c);
  }
  return map;
}

function latestPriorDateWithBars(
  byDate: Map<string, number[]>,
  todayEt: string,
): string | null {
  const priorDates = [...byDate.keys()].filter((d) => d < todayEt).sort();
  for (let i = priorDates.length - 1; i >= 0; i--) {
    const d = priorDates[i]!;
    if ((byDate.get(d)?.length ?? 0) >= MIN_SESSION_BARS) return d;
  }
  return null;
}

/**
 * Prior trading day's last print including POST settlement (~16:10 ET).
 * Used for CBOE indices like ^VIX where Yahoo `meta.previousClose` is stale
 * and the official close is not the 15:55 regular-session bar.
 */
export function priorDaySettlementClose(
  timestamps: number[],
  closes: (number | null)[],
  now: Date = new Date(),
): number | null {
  const byDate = byDateAllCloses(timestamps, closes);
  const prevDate = latestPriorDateWithBars(byDate, todayEtIsoDate(now));
  if (!prevDate) return null;
  const bars = byDate.get(prevDate)!;
  return bars[bars.length - 1] ?? null;
}

/**
 * Today's sparkline segments + live price for settlement-mode instruments.
 * REGULAR bars feed the solid sparkline; POST bars feed the dashed tail.
 * `livePrice` is the latest today print across REGULAR + POST.
 */
export function todaySettlementSeries(
  timestamps: number[],
  closes: (number | null)[],
  now: Date = new Date(),
): {
  regular: number[];
  extended: number[];
  livePrice: number | null;
} {
  const sessions = splitIntradaySessions(timestamps, closes);
  const todayEt = todayEtIsoDate(now);
  const todayRegular = sessions.byDateRegular.get(todayEt) ?? [];
  const todayPost = sessions.byDatePost.get(todayEt) ?? [];
  const todayPre = sessions.byDatePre.get(todayEt) ?? [];

  if (todayRegular.length >= MIN_SESSION_BARS) {
    const allToday = [...todayRegular, ...todayPost];
    return {
      regular: decimateSparkline(todayRegular, REGULAR_SPARKLINE_MAX),
      extended: decimateSparkline(todayPost, EXTENDED_SPARKLINE_MAX),
      livePrice: allToday.length > 0 ? allToday[allToday.length - 1]! : null,
    };
  }

  const clockSession = getUsMarketSession(now);
  const carryDate = latestPriorRegularDate(sessions.byDateRegular, todayEt);
  if (carryDate) {
    const byDate = byDateAllCloses(timestamps, closes);
    const priorSettlement = byDate.get(carryDate)?.at(-1) ?? null;
    let extended = [...(sessions.byDatePost.get(carryDate) ?? [])];
    if (clockSession === "PRE") {
      extended = [...extended, ...todayPre];
    }
    const livePrice =
      todayPre.length > 0 ? todayPre[todayPre.length - 1]! : priorSettlement;
    return {
      regular: decimateSparkline(
        sessions.byDateRegular.get(carryDate) ?? [],
        REGULAR_SPARKLINE_MAX,
      ),
      extended: decimateSparkline(extended, EXTENDED_SPARKLINE_MAX),
      livePrice,
    };
  }

  const todayOnly = [...todayPre, ...todayPost];
  return {
    regular: [],
    extended: decimateSparkline(todayOnly, EXTENDED_SPARKLINE_MAX),
    livePrice: todayOnly.length > 0 ? todayOnly[todayOnly.length - 1]! : null,
  };
}
