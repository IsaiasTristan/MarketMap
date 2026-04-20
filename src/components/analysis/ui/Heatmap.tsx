"use client";

interface HeatmapCell {
  x: string;
  y: string;
  value: number;
}

interface HeatmapProps {
  cells: HeatmapCell[];
  xLabels: string[];
  yLabels: string[];
  minValue?: number;
  maxValue?: number;
  formatter?: (v: number) => string;
  cellSize?: number;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function valueToColor(
  value: number,
  min: number,
  max: number,
): string {
  const range = max - min || 1;
  const t = (value - min) / range; // 0 = min, 1 = max
  const mid = (0 - min) / range;

  let r: number, g: number, b: number;

  if (t < mid) {
    // blue (0,50,200) → white (255,255,255)
    const tt = t / (mid || 0.5);
    r = lerp(0, 255, tt);
    g = lerp(50, 255, tt);
    b = lerp(200, 255, tt);
  } else {
    // white (255,255,255) → dark red (180,20,20)
    const tt = (t - mid) / (1 - mid || 0.5);
    r = lerp(255, 180, tt);
    g = lerp(255, 20, tt);
    b = lerp(255, 20, tt);
  }

  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

export function Heatmap({
  cells,
  xLabels,
  yLabels,
  minValue = -1,
  maxValue = 1,
  formatter = (v) => v.toFixed(2),
  cellSize = 36,
}: HeatmapProps) {
  const lookup = new Map(cells.map((c) => [`${c.y}||${c.x}`, c.value]));

  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "inline-flex", flexDirection: "column" }}>
        {/* X axis labels */}
        <div style={{ display: "flex", marginLeft: 80, marginBottom: 4 }}>
          {xLabels.map((xl) => (
            <div
              key={xl}
              style={{
                width: cellSize,
                fontSize: 10,
                color: "var(--text-secondary)",
                textAlign: "center",
                overflow: "hidden",
                whiteSpace: "nowrap",
                transform: "rotate(-45deg)",
                transformOrigin: "bottom center",
              }}
            >
              {xl}
            </div>
          ))}
        </div>

        {/* Rows */}
        {yLabels.map((yl) => (
          <div key={yl} style={{ display: "flex", alignItems: "center" }}>
            {/* Y label */}
            <div
              style={{
                width: 80,
                fontSize: 10,
                color: "var(--text-secondary)",
                textAlign: "right",
                paddingRight: 8,
                overflow: "hidden",
                whiteSpace: "nowrap",
              }}
            >
              {yl}
            </div>
            {xLabels.map((xl) => {
              const val = lookup.get(`${yl}||${xl}`);
              const bg =
                val !== undefined
                  ? valueToColor(val, minValue, maxValue)
                  : "var(--bg-elevated)";
              const textColor =
                val !== undefined && Math.abs(val) > 0.5 ? "#fff" : "#000";

              return (
                <div
                  key={xl}
                  title={val !== undefined ? `${yl} × ${xl}: ${formatter(val)}` : ""}
                  style={{
                    width: cellSize,
                    height: cellSize,
                    background: bg,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 9,
                    color: textColor,
                    fontFamily: "var(--font-jetbrains-mono, monospace)",
                    border: "1px solid var(--bg-base)",
                    cursor: "default",
                  }}
                >
                  {val !== undefined ? formatter(val) : ""}
                </div>
              );
            })}
          </div>
        ))}

        {/* Legend */}
        <div
          style={{
            marginLeft: 80,
            marginTop: 8,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
            {formatter(minValue)}
          </span>
          <div
            style={{
              flex: 1,
              height: 8,
              background:
                "linear-gradient(90deg, #0032c8, #fff, #b41414)",
              borderRadius: 4,
              maxWidth: Math.min(200, xLabels.length * cellSize),
            }}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
            {formatter(maxValue)}
          </span>
        </div>
      </div>
    </div>
  );
}
