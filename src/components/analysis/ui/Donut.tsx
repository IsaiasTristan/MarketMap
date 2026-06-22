"use client";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export interface DonutSlice {
  name: string;
  /** Value used for the slice arc length. Always non-negative for renderable pies. */
  value: number;
  color?: string;
  /**
   * Marks the slice as semantically negative (e.g. a position that lost money).
   * The slice still uses |value| for its arc; this only adds a red outline.
   */
  negative?: boolean;
  /** Optional secondary label shown in the legend (e.g. `$2.3k / 1.4%`). */
  secondary?: string;
}

// recharts needs resolved colors — we use explicit hex fallbacks
const CHART_COLORS_HEX = [
  "var(--chart-1)",
  "#22c55e",
  "#f59e0b",
  "var(--chart-4)",
  "#e879f9",
  "#fb923c",
  "#38bdf8",
  "#a78bfa",
  "#f97316",
  "#84cc16",
];

const NEGATIVE_OUTLINE = "#ef4444";

interface DonutProps {
  data: DonutSlice[];
  centerLabel?: string;
  centerSub?: string;
  /** Color for the center primary label (defaults to text-primary). */
  centerColor?: string;
  height?: number;
  /**
   * Tooltip value formatter. The third arg is the recharts payload entry —
   * its `.payload` carries the original `DonutSlice` so per-dimension tooltips
   * can reach back for signed-return / dollar-VaR metadata.
   */
  formatter?: (
    value: unknown,
    name?: string | number,
    entry?: unknown,
  ) => string;
}

export function Donut({
  data,
  centerLabel,
  centerSub,
  centerColor,
  height = 280,
  formatter = (v: unknown) => `${(v as number).toFixed(1)}%`,
}: DonutProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 12,
        height,
        width: "100%",
      }}
    >
      {/* Donut (fills available height; legend lives to the right) */}
      <div style={{ position: "relative", flex: "1 1 auto", minWidth: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius="58%"
              outerRadius="92%"
              paddingAngle={2}
              dataKey="value"
              label={false}
              startAngle={90}
              endAngle={-270}
              isAnimationActive={false}
            >
              {data.map((entry, i) => (
                <Cell
                  key={entry.name}
                  fill={entry.color ?? CHART_COLORS_HEX[i % CHART_COLORS_HEX.length]}
                  stroke={entry.negative ? NEGATIVE_OUTLINE : undefined}
                  strokeWidth={entry.negative ? 2 : 0}
                />
              ))}
            </Pie>
            <Tooltip
              formatter={formatter}
              contentStyle={{ ...bbTooltipStyle, fontSize: 13 }}
              labelStyle={{ color: "#fff" }}
              itemStyle={{ color: "var(--text-secondary)" }}
            />
          </PieChart>
        </ResponsiveContainer>

        {/* HTML center overlay — sits over the pie hole so wrapping is reliable */}
        {(centerLabel || centerSub) && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              textAlign: "center",
              pointerEvents: "none",
              lineHeight: 1.2,
            }}
          >
            {centerLabel && (
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: centerColor ?? "var(--text-primary)",
                  fontFamily: "var(--font-mono, monospace)",
                  whiteSpace: "nowrap",
                }}
              >
                {centerLabel}
              </div>
            )}
            {centerSub && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  marginTop: 2,
                  whiteSpace: "nowrap",
                }}
              >
                {centerSub}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Custom legend — supports optional secondary value per slice */}
      <div
        style={{
          flex: "0 0 140px",
          maxHeight: "100%",
          overflowY: "auto",
          fontSize: 12,
          color: "var(--text-secondary)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 4,
          paddingRight: 4,
        }}
      >
        {data.map((slice, i) => (
          <div
            key={slice.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              minWidth: 0,
            }}
          >
            <span
              style={{
                flex: "0 0 8px",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background:
                  slice.color ?? CHART_COLORS_HEX[i % CHART_COLORS_HEX.length],
                outline: slice.negative ? `1.5px solid ${NEGATIVE_OUTLINE}` : "none",
                outlineOffset: slice.negative ? 1 : 0,
              }}
            />
            <span
              style={{
                flex: "1 1 auto",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {slice.name}
            </span>
            {slice.secondary && (
              <span
                style={{
                  flex: "0 0 auto",
                  color: "var(--text-tertiary, #94a3b8)",
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: 11,
                }}
              >
                {slice.secondary}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
