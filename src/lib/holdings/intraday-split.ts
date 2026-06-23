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

/** Decimate by stride, preserving first and last samples. */
export function decimateSparkline(arr: number[], maxLen: number): number[] {
  if (arr.length <= maxLen) return arr;
  const stride = Math.ceil(arr.length / maxLen);
  const out: number[] = [];
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
