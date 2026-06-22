"use client";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import type { FactorCode, AttributionResult } from "@/types/factors";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";

interface ExposureHistory {
  dates: string[];
  series: Record<string, number[]>;
  alphas: number[];
  rSquareds: number[];
}

interface TimeSeriesPanelProps {
  history: ExposureHistory | null | undefined;
  attribution: AttributionResult | null | undefined;
}

const FACTOR_COLORS: Record<string, string> = {
  MKT_RF: "var(--chart-1)",
  SMB: "#22c55e",
  HML: "#f59e0b",
  RMW: "var(--chart-4)",
  CMA: "#e879f9",
  MOM: "#fb923c",
};

export function TimeSeriesPanel({ history, attribution }: TimeSeriesPanelProps) {
  // Defensive: any non-2xx API response (or stale shape) lands here as an
  // error/null payload — guard before treating it as ExposureHistory.
  const safeHistory =
    history && typeof history === "object" && history.series && typeof history.series === "object"
      ? history
      : null;

  // Rolling betas chart
  const betaChartData =
    safeHistory?.dates?.map((d, i) => {
      const point: Record<string, number | string> = { date: d.slice(0, 10) };
      for (const [code, values] of Object.entries(safeHistory.series)) {
        point[code] = values[i] ?? 0;
      }
      return point;
    }) ?? [];

  const seriesKeys = safeHistory ? Object.keys(safeHistory.series) : [];

  // Cumulative attribution chart
  const cumulChartData =
    attribution?.cumulative?.slice(-252).map((pt) => {
      const point: Record<string, number | string> = { date: (pt.date as string).slice(0, 10) };
      point["Alpha"] = (pt.cumulativeAlpha as number) * 100;
      for (const [key, val] of Object.entries(pt.byFactor)) {
        point[key] = (val as number) * 100;
      }
      return point;
    }) ?? [];

  const cumulKeys = attribution?.cumulative?.[0]
    ? Object.keys(attribution.cumulative[0].byFactor)
    : [];

  const tickFmt = (d: string) => d.slice(0, 7);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Rolling betas */}
      <ChartCard
        title="Rolling Factor Betas"
        subtitle="Historical factor loading estimates from rolling regression window"
      >
        {betaChartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={betaChartData} margin={{ left: -10, right: 10 }}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                tickFormatter={tickFmt}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => v.toFixed(1)}
              />
              <ReferenceLine y={0} stroke="var(--bg-border)" strokeDasharray="2 2" />
              <ReferenceLine y={1} stroke="rgba(99,102,241,0.3)" strokeDasharray="3 3" />
              <Tooltip
                contentStyle={bbTooltipStyle}
                formatter={(v, name) => [Number(v ?? 0).toFixed(3), String(name ?? "")]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {seriesKeys.map((code) => (
                <Line
                  key={code}
                  type="monotone"
                  dataKey={code}
                  stroke={FACTOR_COLORS[code] ?? "#94a3b8"}
                  strokeWidth={1.5}
                  dot={false}
                  name={getFactorDef(code as FactorCode).shortLabel}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ height: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
              No rolling history yet — not enough aligned trading days to fit the rolling regression.
              Add more price history, then refresh the factor data pipeline.
            </span>
          </div>
        )}
      </ChartCard>

      {/* Cumulative attribution */}
      {cumulChartData.length > 0 && (
        <ChartCard
          title="Cumulative Return Attribution"
          subtitle="Additive decomposition of portfolio returns into factor and alpha components (%)"
        >
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={cumulChartData} margin={{ left: -10, right: 10 }}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                tickFormatter={tickFmt}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v.toFixed(0)}%`}
              />
              <ReferenceLine y={0} stroke="var(--bg-border)" />
              <Tooltip
                contentStyle={bbTooltipStyle}
                formatter={(v, name) => [`${Number(v ?? 0).toFixed(2)}%`, String(name ?? "")]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {cumulKeys.map((code) => (
                <Area
                  key={code}
                  type="monotone"
                  dataKey={code}
                  stroke={FACTOR_COLORS[code] ?? "#94a3b8"}
                  fill={`${FACTOR_COLORS[code] ?? "#94a3b8"}18`}
                  strokeWidth={1.5}
                  dot={false}
                  name={getFactorDef(code as FactorCode).shortLabel}
                  stackId="a"
                />
              ))}
              <Area
                type="monotone"
                dataKey="Alpha"
                stroke="#f1f5f9"
                fill="rgba(241,245,249,0.12)"
                strokeWidth={1.5}
                strokeDasharray="4 2"
                dot={false}
                name="Alpha"
                stackId="a"
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
  );
}
