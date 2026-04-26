"use client";

import { divergingHeatColor } from "@/domain/calculations/heatmap";

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
            <div
              style={{
                width: 80,
                fontSize: 10,
                color: "var(--text-label)",
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
                  ? divergingHeatColor(val, minValue, maxValue)
                  : "var(--bg-elevated)";

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
                    color: val !== undefined ? "#fff" : "var(--text-muted)",
                    fontFamily: "var(--font-mono, monospace)",
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
              background: "linear-gradient(90deg, rgb(180,30,30), rgb(70,70,70), rgb(30,150,30))",
              borderRadius: 0,
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
