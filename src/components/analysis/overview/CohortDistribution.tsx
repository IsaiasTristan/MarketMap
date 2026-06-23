"use client";

import { useMemo } from "react";
import { returnHistogram } from "@/domain/calculations/distribution";
import { dayRangeMarkerPosition } from "@/lib/holdings/day-range";
import {
  BB_GRID_FONT_STACK,
  BB_GRID_META_FONT_SIZE,
} from "@/components/analysis/factors/shared/bloomberg-grid";

const WIDTH = 56;
const HEIGHT = 18;

interface CohortDistributionProps {
  dist: number[];
  stockReturn: number;
  pctile: number | null;
}

export function CohortDistribution({
  dist,
  stockReturn,
  pctile,
}: CohortDistributionProps) {
  const { pathD, markerX } = useMemo(() => {
    if (dist.length < 3) {
      return { pathD: "", markerX: WIDTH / 2 };
    }
    const bins = returnHistogram(dist, 12);
    const maxD = Math.max(...bins.map((b) => b.normalDensity), 1e-9);
    const minR = bins[0]!.rangeMin;
    const maxR = bins[bins.length - 1]!.rangeMax;
    const span = maxR - minR || 0.001;

    const points = bins.map((b) => {
      const x = ((b.rangeMin + b.rangeMax) / 2 - minR) / span;
      const y = b.normalDensity / maxD;
      return {
        x: 2 + x * (WIDTH - 4),
        y: HEIGHT - 3 - y * (HEIGHT - 6),
      };
    });

    const pathD =
      points.length > 0
        ? `M ${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ")}`
        : "";

    const markerX =
      2 +
      dayRangeMarkerPosition(minR, maxR, stockReturn) * (WIDTH - 4);

    return { pathD, markerX };
  }, [dist, stockReturn]);

  if (dist.length < 3) {
    return (
      <span style={{ fontSize: BB_GRID_META_FONT_SIZE, color: "var(--text-muted)" }}>
        —
      </span>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        justifyContent: "center",
      }}
    >
      <svg width={WIDTH} height={HEIGHT} aria-hidden style={{ display: "block", flexShrink: 0 }}>
        <path
          d={pathD}
          fill="none"
          stroke="var(--text-muted)"
          strokeWidth={1.2}
        />
        <line
          x1={markerX}
          x2={markerX}
          y1={1}
          y2={HEIGHT - 1}
          stroke="var(--color-accent)"
          strokeWidth={1.5}
        />
        <circle
          cx={markerX}
          cy={HEIGHT - 3}
          r={2}
          fill="var(--color-accent)"
        />
      </svg>
      {pctile != null && (
        <span
          style={{
            fontSize: BB_GRID_META_FONT_SIZE,
            fontFamily: BB_GRID_FONT_STACK,
            color: "var(--text-secondary)",
            whiteSpace: "nowrap",
          }}
        >
          P={pctile}
        </span>
      )}
    </div>
  );
}
