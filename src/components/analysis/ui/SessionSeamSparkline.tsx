"use client";

import {
  computeSeamLayout,
  mapSeriesToX,
  type SparklineTimeMode,
} from "@/lib/market/sparkline-session-layout";
import { getUsMarketSession } from "@/lib/market-map/market-session";

const DEFAULT_WIDTH = 60;
const DEFAULT_HEIGHT = 18;

export interface SessionSeamSparklineProps {
  priorSeries?: number[];
  todaySeries: number[];
  extendedSeries?: number[];
  prevClose: number | null;
  timeMode: SparklineTimeMode;
  /** Last-resort today series when primary is empty (e.g. prior session carry). */
  fallbackTodaySeries?: number[];
  width?: number;
  height?: number;
  /** Stretch to container width via viewBox (holdings table seam layout). */
  fluid?: boolean;
}

function hasFinitePrevClose(prevClose: number | null): prevClose is number {
  return prevClose != null && Number.isFinite(prevClose) && prevClose !== 0;
}

/**
 * Bloomberg-style session seam sparkline:
 * prior session (white) | dashed divider | today's session (bicolor vs prev
 * close, time-proportional width) | optional PRE/POST tail (dashed gray).
 */
export function SessionSeamSparkline({
  priorSeries = [],
  todaySeries,
  extendedSeries = [],
  prevClose,
  timeMode,
  fallbackTodaySeries = [],
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  fluid = false,
}: SessionSeamSparklineProps) {
  const prior = priorSeries ?? [];
  const today =
    todaySeries.length >= 2
      ? todaySeries
      : fallbackTodaySeries.length >= 2
        ? fallbackTodaySeries
        : todaySeries;
  const extended = extendedSeries ?? [];

  const hasPrior = prior.length >= 2;
  const hasToday = today.length >= 2 && hasFinitePrevClose(prevClose);
  const hasExtended = extended.length >= 2;

  if (!hasPrior && !hasToday && !hasExtended) {
    return null;
  }

  const logicalWidth = fluid ? DEFAULT_WIDTH : width;
  const layout = computeSeamLayout({
    totalWidth: logicalWidth,
    timeMode,
    hasPrior,
    hasToday,
    hasExtended,
    now: new Date(),
    clockSession: getUsMarketSession(new Date()),
  });

  const allValues = [
    ...(hasPrior ? prior : []),
    ...(hasToday ? today : []),
    ...(hasExtended ? extended : []),
    ...(hasFinitePrevClose(prevClose) ? [prevClose] : []),
  ];

  let dataMin = Math.min(...allValues);
  let dataMax = Math.max(...allValues);
  if (dataMin === dataMax) {
    dataMin -= 1;
    dataMax += 1;
  }
  const span = dataMax - dataMin;
  const pad = span * 0.1;
  const yMin = dataMin - pad;
  const yMax = dataMax + pad;

  const toY = (v: number) =>
    height - ((v - yMin) / (yMax - yMin)) * height;

  const baselineY = hasFinitePrevClose(prevClose)
    ? toY(prevClose)
    : height / 2;

  const [priorStart, priorEnd] = layout.priorXRange;
  const [todayStart, todayEnd] = layout.todayXRange;

  const priorPts = hasPrior
    ? prior.map((v, i) =>
        `${mapSeriesToX(i, prior.length, priorStart, priorEnd).toFixed(2)},${toY(v).toFixed(2)}`,
      )
    : [];

  const todayPts = hasToday
    ? today.map((v, i) =>
        `${mapSeriesToX(i, today.length, todayStart, todayEnd).toFixed(2)},${toY(v).toFixed(2)}`,
      )
    : [];

  const extRange = layout.extendedXRange;
  const extPts =
    hasExtended && extRange
      ? extended.map((v, i) =>
          `${mapSeriesToX(i, extended.length, extRange[0], extRange[1]).toFixed(2)},${toY(v).toFixed(2)}`,
        )
      : [];

  const priorLinePath = priorPts.length > 0 ? `M${priorPts.join(" L")}` : "";
  const priorAreaPath =
    priorPts.length > 0
      ? `M${priorStart.toFixed(2)},${height.toFixed(2)} L${priorPts.join(
          " L",
        )} L${priorEnd.toFixed(2)},${height.toFixed(2)} Z`
      : "";

  const todayLinePath = todayPts.length > 0 ? `M${todayPts.join(" L")}` : "";
  const todayAreaPath =
    todayPts.length > 0
      ? `M${todayStart.toFixed(2)},${baselineY.toFixed(2)} L${todayPts.join(
          " L",
        )} L${todayEnd.toFixed(2)},${baselineY.toFixed(2)} Z`
      : "";

  const extLinePath = extPts.length > 0 ? `M${extPts.join(" L")}` : "";
  const bridgePath =
    hasToday && hasExtended && extPts.length > 0 && todayPts.length > 0
      ? `M${todayPts[todayPts.length - 1]} L${extPts[0]}`
      : hasPrior && hasExtended && extPts.length > 0 && priorPts.length > 0 && !hasToday
        ? `M${priorPts[priorPts.length - 1]} L${extPts[0]}`
        : "";

  const uid = `${prior.length}-${today.length}-${extended.length}-${baselineY.toFixed(0)}-${logicalWidth}`;

  const svgProps = fluid
    ? {
        width: "100%" as const,
        height,
        viewBox: `0 0 ${DEFAULT_WIDTH} ${height}`,
        preserveAspectRatio: "none" as const,
        style: { display: "block", verticalAlign: "middle" as const },
      }
    : {
        width,
        height,
        style: { flexShrink: 0, display: "block" },
      };

  const todayClipWidth = Math.max(0, todayEnd - todayStart);

  return (
    <svg {...svgProps} aria-hidden>
      {hasPrior && (
        <>
          <path
            d={priorAreaPath}
            fill="var(--text-muted)"
            fillOpacity={0.25}
          />
          <path
            d={priorLinePath}
            fill="none"
            stroke="var(--text-secondary)"
            strokeWidth={1}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </>
      )}

      {layout.showDivider && (
        <line
          x1={layout.joinX}
          x2={layout.joinX}
          y1={1}
          y2={height - 1}
          stroke="var(--text-muted)"
          strokeWidth={0.75}
          strokeDasharray="2 2"
          opacity={0.7}
        />
      )}

      {hasToday && todayClipWidth > 0 && (
        <>
          <defs>
            <clipPath id={`seam-above-${uid}`}>
              <rect
                x={todayStart}
                y={0}
                width={todayClipWidth}
                height={baselineY}
              />
            </clipPath>
            <clipPath id={`seam-below-${uid}`}>
              <rect
                x={todayStart}
                y={baselineY}
                width={todayClipWidth}
                height={Math.max(0, height - baselineY)}
              />
            </clipPath>
          </defs>
          <path
            d={todayAreaPath}
            fill="var(--color-positive)"
            fillOpacity={0.45}
            clipPath={`url(#seam-above-${uid})`}
          />
          <path
            d={todayAreaPath}
            fill="var(--color-negative)"
            fillOpacity={0.45}
            clipPath={`url(#seam-below-${uid})`}
          />
          <line
            x1={todayStart}
            x2={todayEnd}
            y1={baselineY}
            y2={baselineY}
            stroke="var(--text-muted)"
            strokeDasharray="2 2"
            strokeWidth={0.75}
            opacity={0.6}
          />
          <path
            d={todayLinePath}
            fill="none"
            stroke="var(--text-secondary)"
            strokeWidth={1}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </>
      )}

      {hasExtended && extPts.length > 0 && (
        <>
          {bridgePath && (
            <path
              d={bridgePath}
              fill="none"
              stroke="var(--text-muted)"
              strokeWidth={1}
              strokeDasharray="2 2"
              strokeLinecap="round"
            />
          )}
          <path
            d={extLinePath}
            fill="none"
            stroke="var(--text-muted)"
            strokeWidth={1}
            strokeDasharray="2 2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}
