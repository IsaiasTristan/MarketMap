"use client";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import {
  BB_GRID_FONT_STACK,
} from "@/components/analysis/factors/shared/bloomberg-grid";
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

const NEGATIVE_OUTLINE = "var(--bb-red)";
const MIN_DONUT_SIZE = 120;

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
  height = 260,
  formatter = (v: unknown) => `${(v as number).toFixed(1)}%`,
}: DonutProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        height: "100%",
        minHeight: height,
        width: "100%",
        gap: 8,
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          maxWidth: 180,
          overflowY: "auto",
          fontSize: 11,
          color: "var(--text-secondary)",
          fontFamily: BB_GRID_FONT_STACK,
          padding: "4px 0 4px 6px",
        }}
      >
        {data.map((slice, i) => (
          <div
            key={slice.name}
            style={{
              display: "grid",
              gridTemplateColumns: "8px auto auto",
              alignItems: "center",
              gap: 6,
              padding: "1px 4px 1px 0",
              minHeight: 14,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                flexShrink: 0,
                background:
                  slice.color ?? CHART_COLORS_HEX[i % CHART_COLORS_HEX.length],
                outline: slice.negative ? `1.5px solid ${NEGATIVE_OUTLINE}` : "none",
                outlineOffset: slice.negative ? 1 : 0,
              }}
            />
            <span
              style={{
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={slice.name}
            >
              {slice.name}
            </span>
            {slice.secondary && (
              <span
                style={{
                  color: "var(--text-tertiary, #94a3b8)",
                  fontFamily: BB_GRID_FONT_STACK,
                  fontSize: 10,
                  whiteSpace: "nowrap",
                }}
              >
                {slice.secondary}
              </span>
            )}
          </div>
        ))}
      </div>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 8,
          containerType: "size",
        }}
      >
        <div
          style={{
            position: "relative",
            width: `max(${MIN_DONUT_SIZE}px, min(100cqw, 100cqh))`,
            height: `max(${MIN_DONUT_SIZE}px, min(100cqw, 100cqh))`,
            flexShrink: 0,
            containerType: "size",
          }}
        >
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
                contentStyle={{ ...bbTooltipStyle, fontSize: 11 }}
                labelStyle={{ color: "#fff" }}
                itemStyle={{ color: "var(--text-secondary)" }}
              />
            </PieChart>
          </ResponsiveContainer>

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
                    fontSize: "clamp(12px, 4cqw, 16px)",
                    fontWeight: 700,
                    color: centerColor ?? "var(--text-primary)",
                    fontFamily: BB_GRID_FONT_STACK,
                    whiteSpace: "nowrap",
                  }}
                >
                  {centerLabel}
                </div>
              )}
              {centerSub && (
                <div
                  style={{
                    fontSize: "clamp(8px, 2.5cqw, 10px)",
                    color: "var(--text-secondary)",
                    marginTop: 2,
                    whiteSpace: "nowrap",
                    fontFamily: BB_GRID_FONT_STACK,
                  }}
                >
                  {centerSub}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
