"use client";

import { SessionSeamSparkline } from "@/components/analysis/ui/SessionSeamSparkline";

interface GraySparklineProps {
  series: number[];
  width?: number;
  height?: number;
  fluid?: boolean;
}

/**
 * @deprecated Prefer SessionSeamSparkline with priorSeries only. Thin wrapper.
 */
export function GraySparkline({
  series,
  width,
  height,
  fluid,
}: GraySparklineProps) {
  return (
    <SessionSeamSparkline
      priorSeries={series}
      todaySeries={[]}
      prevClose={null}
      timeMode="us_regular"
      width={width}
      height={height}
      fluid={fluid}
    />
  );
}
