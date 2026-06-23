"use client";

import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import { fmt$, fmtPct } from "@/components/analysis/overview/formatters";
import { BB_GRID_FONT_STACK } from "@/components/analysis/factors/shared/bloomberg-grid";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  LabelList,
} from "recharts";

export type ContributorPosition = {
  ticker: string;
  dailyPnl: number;
  dailyPnlPct: number;
};

interface ContributorsChartProps {
  positions: ContributorPosition[];
}

const MIN_ROW_HEIGHT = 24;
const BAR_SIZE = 18;
const AXIS_HEIGHT = 24;
const SUB_LABEL_HEIGHT = 18;

const AXIS_TICK = {
  fontSize: 11,
  fill: "var(--text-secondary)",
  fontFamily: BB_GRID_FONT_STACK,
};

const LABEL_STYLE = {
  fill: "var(--text-secondary)",
  fontSize: 10,
  fontFamily: BB_GRID_FONT_STACK,
};

function niceDollarStep(maxAbs: number): number {
  if (maxAbs <= 500) return 100;
  if (maxAbs <= 2000) return 500;
  if (maxAbs <= 10000) return 1000;
  if (maxAbs <= 50000) return 5000;
  return 10000;
}

function buildDollarTicks(data: ContributorPosition[]): number[] {
  const maxAbs = Math.max(...data.map((d) => Math.abs(d.dailyPnl)), 100);
  const step = niceDollarStep(maxAbs);
  const limit = Math.ceil(maxAbs / step) * step;
  const ticks: number[] = [];
  for (let v = -limit; v <= limit + step / 2; v += step) {
    ticks.push(Math.round(v));
  }
  return ticks;
}

function formatDollarTick(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return `$${(v / 1000).toFixed(0)}k`;
  if (abs === 0) return "$0";
  return `$${v}`;
}

type BarValueLabelProps = {
  x?: string | number;
  y?: string | number;
  width?: string | number;
  height?: string | number;
  value?: number;
  formatter: (v: number) => string;
};

function BarValueLabel(props: BarValueLabelProps) {
  const x = Number(props.x ?? 0);
  const y = Number(props.y ?? 0);
  const width = Number(props.width ?? 0);
  const height = Number(props.height ?? 0);
  const value = Number(props.value ?? 0);
  const { formatter } = props;
  if (value === 0 || !Number.isFinite(value)) return null;
  const text = formatter(value);
  const positive = value >= 0;
  const tipX = x + width;
  const labelX = positive ? tipX + 4 : tipX - 4;
  const anchor = positive ? "start" : "end";
  const cy = y + height / 2;

  return (
    <text
      x={labelX}
      y={cy}
      textAnchor={anchor}
      dominantBaseline="middle"
      style={LABEL_STYLE}
    >
      {text}
    </text>
  );
}

function DollarChart({
  data,
  ticks,
}: {
  data: ContributorPosition[];
  ticks: number[];
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        layout="vertical"
        data={data}
        margin={{ left: 8, right: 56, top: 0, bottom: 0 }}
        barCategoryGap={0}
      >
        <XAxis
          type="number"
          ticks={ticks}
          tickFormatter={formatDollarTick}
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
          height={AXIS_HEIGHT}
        />
        <YAxis type="category" dataKey="ticker" hide width={0} />
        <ReferenceLine x={0} stroke="var(--bg-border)" />
        <Tooltip
          formatter={(v) => [fmt$(v as number), "Daily P&L"]}
          contentStyle={bbTooltipStyle}
          labelStyle={{ color: "#fff" }}
          itemStyle={{ color: "var(--text-secondary)" }}
        />
        <Bar dataKey="dailyPnl" radius={0} barSize={BAR_SIZE}>
          {data.map((entry, i) => (
            <Cell
              key={i}
              fill={entry.dailyPnl >= 0 ? "var(--bb-green)" : "var(--bb-red)"}
            />
          ))}
          <LabelList
            dataKey="dailyPnl"
            content={(props) => (
              <BarValueLabel
                x={props.x}
                y={props.y}
                width={props.width}
                height={props.height}
                value={Number(props.value)}
                formatter={(v) => fmt$(v)}
              />
            )}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function PctChart({ data }: { data: ContributorPosition[] }) {
  const pctData = data.map((d) => ({
    ...d,
    dailyPnlPctDisplay: d.dailyPnlPct * 100,
  }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        layout="vertical"
        data={pctData}
        margin={{ left: 8, right: 48, top: 0, bottom: 0 }}
        barCategoryGap={0}
      >
        <XAxis
          type="number"
          tickFormatter={(v) => `${v.toFixed(1)}%`}
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
          height={AXIS_HEIGHT}
        />
        <YAxis type="category" dataKey="ticker" hide width={0} />
        <ReferenceLine x={0} stroke="var(--bg-border)" />
        <Tooltip
          formatter={(v) => [fmtPct((v as number) / 100), "Daily P&L %"]}
          contentStyle={bbTooltipStyle}
          labelStyle={{ color: "#fff" }}
          itemStyle={{ color: "var(--text-secondary)" }}
        />
        <Bar dataKey="dailyPnlPctDisplay" radius={0} barSize={BAR_SIZE}>
          {pctData.map((entry, i) => (
            <Cell
              key={i}
              fill={entry.dailyPnlPct >= 0 ? "var(--bb-green)" : "var(--bb-red)"}
            />
          ))}
          <LabelList
            dataKey="dailyPnlPctDisplay"
            content={(props) => (
              <BarValueLabel
                x={props.x}
                y={props.y}
                width={props.width}
                height={props.height}
                value={Number(props.value)}
                formatter={(v) => fmtPct(v / 100)}
              />
            )}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

const subLabelStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 0,
  fontFamily: BB_GRID_FONT_STACK,
  padding: "4px 6px 0",
  height: SUB_LABEL_HEIGHT,
  boxSizing: "border-box",
};

function tickerColumnWidth(tickers: string[]): number {
  const longest = tickers.reduce((max, t) => Math.max(max, t.length), 0);
  return Math.min(96, Math.max(52, longest * 7 + 12));
}

export function ContributorsChart({ positions }: ContributorsChartProps) {
  const contribData = [...positions].sort((a, b) => b.dailyPnl - a.dailyPnl);
  const rowCount = contribData.length;
  const minPlotHeight = Math.max(MIN_ROW_HEIGHT, rowCount * MIN_ROW_HEIGHT);
  const colWidth = tickerColumnWidth(contribData.map((d) => d.ticker));
  const dollarTicks = buildDollarTicks(contribData);

  return (
    <ChartCard title="Contributors & Detractors" compact fillHeight>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `${colWidth}px 1fr 1fr`,
          gridTemplateRows: `${SUB_LABEL_HEIGHT}px 1fr`,
          gap: 4,
          height: "100%",
          minHeight: minPlotHeight + SUB_LABEL_HEIGHT + AXIS_HEIGHT,
        }}
      >
        <div
          style={{
            gridColumn: 1,
            gridRow: 2,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div
            style={{
              flex: 1,
              minHeight: minPlotHeight,
              display: "grid",
              gridTemplateRows: `repeat(${rowCount}, 1fr)`,
            }}
          >
            {contribData.map((d) => (
              <div
                key={d.ticker}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  paddingRight: 8,
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  fontFamily: BB_GRID_FONT_STACK,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={d.ticker}
              >
                {d.ticker}
              </div>
            ))}
          </div>
          <div style={{ height: AXIS_HEIGHT, flexShrink: 0 }} />
        </div>

        <div style={{ gridColumn: 2, gridRow: 1, ...subLabelStyle }}>By $</div>
        <div
          style={{
            gridColumn: 2,
            gridRow: 2,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ flex: 1, minHeight: minPlotHeight }}>
            <DollarChart data={contribData} ticks={dollarTicks} />
          </div>
        </div>

        <div style={{ gridColumn: 3, gridRow: 1, ...subLabelStyle }}>By %</div>
        <div
          style={{
            gridColumn: 3,
            gridRow: 2,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ flex: 1, minHeight: minPlotHeight }}>
            <PctChart data={contribData} />
          </div>
        </div>
      </div>
    </ChartCard>
  );
}
