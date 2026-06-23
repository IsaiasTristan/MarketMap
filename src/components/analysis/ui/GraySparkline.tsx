"use client";

const DEFAULT_WIDTH = 60;
const DEFAULT_HEIGHT = 18;

interface GraySparklineProps {
  series: number[];
  width?: number;
  height?: number;
  /** Stretch to container width via viewBox (holdings table seam layout). */
  fluid?: boolean;
}

/**
 * Neutral gray intraday sparkline for the prior trading session.
 */
export function GraySparkline({
  series,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  fluid = false,
}: GraySparklineProps) {
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

  if (series.length < 2) {
    return (
      <svg {...svgProps} aria-hidden>
        <line
          x1={0}
          x2={DEFAULT_WIDTH}
          y1={height / 2}
          y2={height / 2}
          stroke="var(--chrome-border)"
          strokeDasharray="2 2"
          strokeWidth={1}
        />
      </svg>
    );
  }

  let dataMin = Math.min(...series);
  let dataMax = Math.max(...series);
  if (dataMin === dataMax) {
    dataMin -= 1;
    dataMax += 1;
  }
  const span = dataMax - dataMin;
  const pad = span * 0.1;
  const yMin = dataMin - pad;
  const yMax = dataMax + pad;

  const logicalWidth = fluid ? DEFAULT_WIDTH : width;
  const toX = (i: number) =>
    series.length === 1 ? logicalWidth / 2 : (i / (series.length - 1)) * logicalWidth;
  const toY = (v: number) =>
    height - ((v - yMin) / (yMax - yMin)) * height;

  const pts = series.map((v, i) => `${toX(i).toFixed(2)},${toY(v).toFixed(2)}`);
  const areaPath = `M${toX(0).toFixed(2)},${height.toFixed(2)} L${pts.join(
    " L",
  )} L${toX(series.length - 1).toFixed(2)},${height.toFixed(2)} Z`;
  const linePath = `M${pts.join(" L")}`;

  return (
    <svg {...svgProps} aria-hidden>
      <path
        d={areaPath}
        fill="var(--text-muted)"
        fillOpacity={0.25}
      />
      <path
        d={linePath}
        fill="none"
        stroke="var(--text-secondary)"
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
