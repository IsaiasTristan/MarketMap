"use client";

import { dayRangeMarkerPosition } from "@/lib/holdings/day-range";

const DEFAULT_WIDTH = 56;
const DEFAULT_HEIGHT = 12;

interface DayRangeBarProps {
  low: number;
  high: number;
  price: number;
  prevClose: number;
  /** Stretch to container width via viewBox (holdings table layout). */
  fluid?: boolean;
}

export function DayRangeBar({
  low,
  high,
  price,
  prevClose,
  fluid = false,
}: DayRangeBarProps) {
  const pos = dayRangeMarkerPosition(low, high, price);
  const positive = price >= prevClose;
  const barColor = positive ? "var(--color-positive)" : "var(--color-negative)";
  const logicalWidth = DEFAULT_WIDTH;
  const markerX = 2 + pos * (logicalWidth - 4);
  const trackY = DEFAULT_HEIGHT / 2;

  const svgProps = fluid
    ? {
        width: "100%" as const,
        height: DEFAULT_HEIGHT,
        viewBox: `0 0 ${DEFAULT_WIDTH} ${DEFAULT_HEIGHT}`,
        preserveAspectRatio: "none" as const,
        style: { display: "block", verticalAlign: "middle" as const },
      }
    : {
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        style: { display: "block" },
      };

  return (
    <svg {...svgProps} aria-hidden>
      <rect
        x={0}
        y={trackY - 2}
        width={logicalWidth}
        height={4}
        fill={barColor}
        fillOpacity={0.35}
        rx={0}
      />
      <line
        x1={markerX}
        x2={markerX}
        y1={1}
        y2={DEFAULT_HEIGHT - 1}
        stroke="#fff"
        strokeWidth={1.5}
      />
    </svg>
  );
}
