import {
  getUsMarketSession,
  type MarketSession,
} from "@/lib/market-map/market-session";

export type SparklineTimeMode = "us_regular" | "et_calendar_day";

/** Left zone fraction for the prior session (matches USD-CAD reference). */
export const DEFAULT_PRIOR_ZONE_FRAC = 0.65;

const REGULAR_START_MIN = 9 * 60 + 30;
const REGULAR_DURATION_MIN = 6 * 60 + 30; // 09:30 → 16:00 ET
const MINUTES_PER_DAY = 24 * 60;

/** Minutes since midnight in US Eastern for `now`. */
export function minutesSinceMidnightEt(now: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/**
 * Elapsed fraction of the active session/day (0..1).
 * - `us_regular`: REGULAR clock progress 09:30–16:00; POST → 1; PRE/CLOSED → 0.
 * - `et_calendar_day`: ET midnight → midnight.
 */
export function computeSessionProgress(
  now: Date,
  mode: SparklineTimeMode,
): number {
  if (mode === "et_calendar_day") {
    return Math.min(
      1,
      Math.max(0, minutesSinceMidnightEt(now) / MINUTES_PER_DAY),
    );
  }

  const session = getUsMarketSession(now);
  if (session === "POST") return 1;
  if (session !== "REGULAR") return 0;

  const m = minutesSinceMidnightEt(now);
  return Math.min(
    1,
    Math.max(0, (m - REGULAR_START_MIN) / REGULAR_DURATION_MIN),
  );
}

/** Map series index `i` of `count` points into `[xStart, xEnd]`. */
export function mapSeriesToX(
  index: number,
  count: number,
  xStart: number,
  xEnd: number,
): number {
  if (count <= 0) return xStart;
  if (count === 1) return (xStart + xEnd) / 2;
  return xStart + (index / (count - 1)) * (xEnd - xStart);
}

export interface SeamLayout {
  joinX: number;
  priorEndX: number;
  todayActiveEndX: number;
  extendedEndX: number;
  sessionProgress: number;
  totalWidth: number;
  priorXRange: [number, number];
  todayXRange: [number, number];
  extendedXRange: [number, number] | null;
  showDivider: boolean;
}

export function computeSeamLayout(input: {
  totalWidth: number;
  priorZoneFrac?: number;
  now?: Date;
  timeMode: SparklineTimeMode;
  hasPrior: boolean;
  hasToday: boolean;
  hasExtended: boolean;
  clockSession?: MarketSession;
}): SeamLayout {
  const {
    totalWidth,
    priorZoneFrac = DEFAULT_PRIOR_ZONE_FRAC,
    now = new Date(),
    timeMode,
    hasPrior,
    hasToday,
    hasExtended,
  } = input;

  const joinX = totalWidth * priorZoneFrac;
  const todayZoneWidth = totalWidth - joinX;
  const sessionProgress = computeSessionProgress(now, timeMode);
  const clockSession = input.clockSession ?? getUsMarketSession(now);

  const todayActiveEndX = joinX + todayZoneWidth * sessionProgress;

  let extendedEndX = todayActiveEndX;
  let extendedXRange: [number, number] | null = null;
  const showExtended =
    hasExtended &&
    (sessionProgress >= 1 ||
      clockSession === "POST" ||
      clockSession === "PRE");
  if (showExtended) {
    extendedEndX = totalWidth;
    const extStart =
      todayActiveEndX > joinX ? todayActiveEndX : joinX;
    extendedXRange = [extStart, totalWidth];
  }

  const priorXRange: [number, number] = hasPrior ? [0, joinX] : [0, 0];
  const todayXRange: [number, number] = hasToday
    ? [joinX, todayActiveEndX]
    : [joinX, joinX];

  return {
    joinX,
    priorEndX: hasPrior ? joinX : 0,
    todayActiveEndX,
    extendedEndX,
    sessionProgress,
    totalWidth,
    priorXRange,
    todayXRange,
    extendedXRange,
    showDivider: hasPrior && (hasToday || showExtended),
  };
}
