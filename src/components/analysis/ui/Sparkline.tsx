"use client";

interface SparklineProps {
  data: number[];
  positive?: boolean;
  height?: number;
  width?: number;
}

export function Sparkline({ data, positive, height = 40, width = 120 }: SparklineProps) {
  if (!data || data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  });

  const color =
    positive === true
      ? "var(--color-positive)"
      : positive === false
        ? "var(--color-negative)"
        : data[data.length - 1] >= data[0]
          ? "var(--color-positive)"
          : "var(--color-negative)";

  const fillId = `sparkfill-${Math.random().toString(36).slice(2)}`;
  const polyline = `M ${pts.join(" L ")}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={`${polyline} L ${width},${height} L 0,${height} Z`}
        fill={`url(#${fillId})`}
      />
      <path d={polyline} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}
