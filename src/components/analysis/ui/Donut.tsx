"use client";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import {
  PieChart,
  Pie,
  Cell,
  Legend,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export interface DonutSlice {
  name: string;
  value: number;
  color?: string;
}

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

// recharts needs resolved colors — we use explicit hex fallbacks
const CHART_COLORS_HEX = [
  "var(--chart-1)",
  "#22c55e",
  "#f59e0b",
  "var(--chart-4)",
  "#e879f9",
  "#fb923c",
];

interface DonutProps {
  data: DonutSlice[];
  centerLabel?: string;
  centerSub?: string;
  height?: number;
  formatter?: (value: unknown) => string;
}

export function Donut({
  data,
  centerLabel,
  centerSub,
  height = 260,
  formatter = (v: unknown) => `${(v as number).toFixed(1)}%`,
}: DonutProps) {
  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          cx="40%"
          cy="50%"
          innerRadius="52%"
          outerRadius="78%"
          paddingAngle={2}
          dataKey="value"
          label={false}
          startAngle={90}
          endAngle={-270}
        >
          {data.map((entry, i) => (
            <Cell
              key={entry.name}
              fill={entry.color ?? CHART_COLORS_HEX[i % CHART_COLORS_HEX.length]}
            />
          ))}
        </Pie>
        {centerLabel && (
          <text
            x="40%"
            y="50%"
            textAnchor="middle"
            dominantBaseline="middle"
            fill="var(--text-primary)"
            fontSize={18}
            fontWeight={700}
            fontFamily="var(--font-mono, monospace)"
          >
            {centerLabel}
          </text>
        )}
        {centerSub && (
          <text
            x="40%"
            y="calc(50% + 20px)"
            textAnchor="middle"
            dominantBaseline="middle"
            fill="var(--text-secondary)"
            fontSize={11}
          >
            {centerSub}
          </text>
        )}
        <Tooltip
          formatter={formatter}
          contentStyle={{ ...bbTooltipStyle, fontSize: 13 }}
          labelStyle={{ color: "#fff" }}
          itemStyle={{ color: "var(--text-secondary)" }}
        />
        <Legend
          layout="vertical"
          align="right"
          verticalAlign="middle"
          iconType="circle"
          iconSize={8}
          formatter={(value) => (
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {value}
            </span>
          )}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}


