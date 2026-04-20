"use client";

interface Zone {
  label: string;
  max: number; // as fraction 0-1
  color: string;
}

interface GaugeProps {
  value: number; // 0 to max
  max?: number;
  zones?: Zone[];
  label?: string;
  sublabel?: string;
  size?: number;
}

const DEFAULT_ZONES: Zone[] = [
  { label: "Diversified", max: 0.35, color: "var(--color-positive)" },
  { label: "Moderate", max: 0.55, color: "var(--color-warning)" },
  { label: "Concentrated", max: 1, color: "var(--color-negative)" },
];

export function Gauge({
  value,
  max = 1,
  zones = DEFAULT_ZONES,
  label,
  sublabel,
  size = 160,
}: GaugeProps) {
  const fraction = Math.min(1, Math.max(0, value / max));
  const cx = size / 2;
  const cy = size * 0.7;
  const r = size * 0.38;
  const strokeW = size * 0.1;

  // Semi-circle arc helpers
  const polarToXY = (angle: number, radius: number) => ({
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  });

  const startAngle = Math.PI; // left
  const endAngle = 0; // right
  const totalAngle = endAngle - startAngle; // negative = going right

  const arcPath = (fromFraction: number, toFraction: number, color: string) => {
    const a1 = startAngle + fromFraction * totalAngle;
    const a2 = startAngle + toFraction * totalAngle;
    const p1 = polarToXY(a1, r);
    const p2 = polarToXY(a2, r);
    const large = Math.abs(a2 - a1) > Math.PI ? 1 : 0;
    return (
      <path
        key={color + fromFraction}
        d={`M ${p1.x} ${p1.y} A ${r} ${r} 0 ${large} 1 ${p2.x} ${p2.y}`}
        fill="none"
        stroke={color}
        strokeWidth={strokeW}
        strokeLinecap="butt"
      />
    );
  };

  // Render zone arcs
  let prev = 0;
  const zoneArcs = zones.map((z) => {
    const arc = arcPath(prev, z.max, z.color);
    prev = z.max;
    return arc;
  });

  // Pointer
  const pointerAngle = startAngle + fraction * totalAngle;
  const innerR = r - strokeW / 2 - 4;
  const outerR = r + strokeW / 2 + 2;
  const pInner = polarToXY(pointerAngle, innerR);
  const pOuter = polarToXY(pointerAngle, outerR);

  // Zone label for current value
  const currentZone = zones.find((z) => fraction <= z.max) ?? zones[zones.length - 1];

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <svg width={size} height={size * 0.65} viewBox={`0 0 ${size} ${size * 0.65}`}>
        {/* Background track */}
        <path
          d={`M ${polarToXY(Math.PI, r).x} ${polarToXY(Math.PI, r).y} A ${r} ${r} 0 0 1 ${polarToXY(0, r).x} ${polarToXY(0, r).y}`}
          fill="none"
          stroke="var(--bg-elevated)"
          strokeWidth={strokeW}
          strokeLinecap="butt"
        />
        {zoneArcs}
        {/* Pointer line */}
        <line
          x1={pInner.x}
          y1={pInner.y}
          x2={pOuter.x}
          y2={pOuter.y}
          stroke="#fff"
          strokeWidth={2}
          strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r={4} fill="#fff" />
      </svg>
      {label && (
        <div
          style={{
            fontFamily: "var(--font-jetbrains-mono, monospace)",
            fontSize: 22,
            fontWeight: 700,
            color: currentZone.color,
            marginTop: -8,
          }}
        >
          {label}
        </div>
      )}
      {sublabel && (
        <div
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            marginTop: 2,
          }}
        >
          {sublabel}
        </div>
      )}
    </div>
  );
}
