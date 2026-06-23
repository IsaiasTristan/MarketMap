"use client";

import {
  SessionSeamSparkline,
  type SessionSeamSparklineProps,
} from "@/components/analysis/ui/SessionSeamSparkline";

interface IntradaySparklineProps {
  series: number[];
  extendedSeries?: number[];
  prevClose: number | null;
  /** Last-resort regular series when primary is empty (e.g. prior session). */
  fallbackSeries?: number[];
  priorSeries?: number[];
  timeMode?: SessionSeamSparklineProps["timeMode"];
  width?: number;
  height?: number;
  fluid?: boolean;
}

/**
 * @deprecated Prefer SessionSeamSparkline directly. Thin wrapper for legacy call sites.
 */
export function IntradaySparkline({
  series,
  extendedSeries = [],
  prevClose,
  fallbackSeries = [],
  priorSeries = [],
  timeMode = "us_regular",
  width,
  height,
  fluid,
}: IntradaySparklineProps) {
  return (
    <SessionSeamSparkline
      priorSeries={priorSeries}
      todaySeries={series}
      extendedSeries={extendedSeries}
      prevClose={prevClose}
      fallbackTodaySeries={fallbackSeries}
      timeMode={timeMode}
      width={width}
      height={height}
      fluid={fluid}
    />
  );
}
