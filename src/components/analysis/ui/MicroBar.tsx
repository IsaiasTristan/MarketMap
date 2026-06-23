"use client";

interface MicroBarProps {
  /** Signed value — bar width scales by |value| relative to maxAbs. */
  value: number;
  /** Max |value| in the column for scaling (defaults to 1). */
  maxAbs?: number;
  /** When true, render as percentage label instead of raw value. */
  asPct?: boolean;
}

export function MicroBar({ value, maxAbs = 1, asPct = false }: MicroBarProps) {
  const scale = maxAbs > 0 ? maxAbs : 1;
  const abs = Math.min(1, Math.abs(value) / scale);
  const positive = value >= 0;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 100 }}>
      <div
        style={{
          position: "relative",
          width: 72,
          height: 6,
          background: "var(--bg-elevated)",
          borderRadius: 0,
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: positive ? "50%" : `${50 - abs * 50}%`,
            top: 0,
            height: "100%",
            width: `${abs * 50}%`,
            background: positive ? "var(--color-positive)" : "var(--color-negative)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 0,
            width: 1,
            height: "100%",
            background: "var(--bg-border)",
          }}
        />
      </div>
      <span
        style={{
          fontSize: 10,
          fontFamily: "var(--font-mono, monospace)",
          color: positive ? "var(--color-positive)" : "var(--color-negative)",
          minWidth: 40,
          textAlign: "right",
        }}
      >
        {asPct
          ? `${positive ? "+" : ""}${(value * 100).toFixed(1)}%`
          : `${positive ? "+" : ""}${value.toFixed(2)}`}
      </span>
    </div>
  );
}
