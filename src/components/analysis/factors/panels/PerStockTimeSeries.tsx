"use client";
/**
 * PerStockTimeSeries — daily factor decomposition chart for a single
 * ticker. Three modes (toggle in the chart header):
 *
 *   Returns  → stacked area: cumulative excess return decomposed into
 *              per-factor contributions + Σ rolling α + Unexplained Residual (Σ ε).
 *              An unfilled "Realised excess (cumulative)" line is overlaid
 *              so the stack visibly closes onto the actual return curve
 *              (Phase 3 §2.2 lock-in: Σy = Σ(β·r) + Σα + Σε).
 *   Risk    → stacked area: rolling per-factor share of variance from the
 *              SAME rolling Euler decomposition the snapshot panel reports
 *              (Phase 3 §2.1 / Q1 lock-in). The latest stack point ties to
 *              the snapshot risk waterfall to ≤ 1 bp.
 *   Beta    → one line per factor: rolling multivariate OLS β_t,f.
 *
 * Burn-in handling (Phase 3 Q2 lock):
 *   The first `displayStartIndex` days have no rolling fit. We grey-overlay
 *   that region and draw a dashed vertical reference line at t = W to flag
 *   the boundary. All identity sums (waterfalls, scatter) consume only the
 *   post-burn-in slice.
 */
import { useMemo } from "react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
} from "recharts";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import type { FactorCode } from "@/types/factors";
import type { FactorTsRollingWindow } from "@/store/analysis";

export interface PerStockTimeSeriesPayload {
  ticker: string;
  name: string;
  model: string;
  windowUsed: number;
  rollingWindow: number;
  displayStartIndex: number;
  burnInIndex: number;
  dates: string[];
  excessReturn: number[];
  actual: number[];
  alpha: (number | null)[];
  residual: (number | null)[];
  predicted: (number | null)[];
  factorContrib: Record<string, (number | null)[]>;
  betas: Record<string, number>;
  rollingBetas: Record<string, (number | null)[]>;
  rollingPctVarianceContrib: Record<string, (number | null)[]>;
  rollingIdioShare: (number | null)[];
  rollingTotalVolAnn: (number | null)[];
  usableFactors: FactorCode[];
  factorMeta: { code: FactorCode; label: string; shortLabel: string; color: string }[];
  rollingFitFailures: number;
  rollingFitFailureDates: string[];
  droppedDates: { date: string; factor: FactorCode }[];
  windowFallback: {
    requestedWindow: number;
    effectiveWindow: number;
    availableObservations: number;
    reason: "INSUFFICIENT_HISTORY" | "INSUFFICIENT_ROOM_FOR_ROLLING_FITS";
  } | null;
}

export function isPerStockTimeSeriesPayload(x: unknown): x is PerStockTimeSeriesPayload {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    Array.isArray(o.dates) &&
    typeof o.factorContrib === "object" &&
    o.factorContrib !== null &&
    typeof o.rollingBetas === "object" &&
    o.rollingBetas !== null &&
    typeof o.rollingPctVarianceContrib === "object" &&
    o.rollingPctVarianceContrib !== null
  );
}

export type PerStockTimeSeriesMetric = "return" | "risk" | "beta";

interface PerStockTimeSeriesProps {
  ticker: string;
  metric: PerStockTimeSeriesMetric;
  onMetricChange: (m: PerStockTimeSeriesMetric) => void;
  rollingWindowSelection: FactorTsRollingWindow;
  onRollingWindowSelectionChange: (w: FactorTsRollingWindow) => void;
  snapshotWindow: number;
  data: PerStockTimeSeriesPayload | null;
  loading?: boolean;
}

const headerStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

function MetricPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "3px 10px",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        background: active ? "var(--bb-chrome)" : "transparent",
        color: active ? "#fff" : "var(--text-secondary)",
        border: "1px solid var(--bg-border)",
        borderRadius: 0,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

const num = (v: number | null | undefined): number => (v == null || !Number.isFinite(v) ? 0 : v);

export function PerStockTimeSeries({
  ticker,
  metric,
  onMetricChange,
  rollingWindowSelection,
  onRollingWindowSelectionChange,
  snapshotWindow,
  data,
  loading,
}: PerStockTimeSeriesProps) {
  // RETURN mode — cumulative stack (factors + Σα + Σε) overlaid by the
  // realised cumulative excess. By construction (Σy = Σ(β·r)+Σα+Σε), the
  // stack TOP and the realised line should overlap throughout the visible
  // window. We start cumulating from `displayStartIndex` so the chart
  // begins at zero on the first visible day (otherwise the cumulative
  // contributions accumulated during the unseen extended-history period
  // would appear as a non-zero offset at t₀ and break the identity tie).
  const returnChartData = useMemo(() => {
    if (!data || metric !== "return") return [];
    const { dates, factorContrib, alpha, residual, factorMeta, excessReturn, displayStartIndex } = data;
    const cumFactor: Record<string, number> = {};
    let cumAlpha = 0;
    let cumResid = 0;
    let cumActual = 0;
    for (const m of factorMeta) cumFactor[m.code] = 0;
    const out: Record<string, number | string>[] = [];
    for (let i = displayStartIndex; i < dates.length; i++) {
      const row: Record<string, number | string> = { date: dates[i]! };
      for (const m of factorMeta) {
        cumFactor[m.code] = (cumFactor[m.code] ?? 0) + num(factorContrib[m.code]?.[i]);
        row[m.code] = cumFactor[m.code]! * 100;
      }
      cumAlpha += num(alpha[i]);
      cumResid += num(residual[i]);
      cumActual += excessReturn[i] ?? 0;
      row["__alpha"] = cumAlpha * 100;
      row["__residual"] = cumResid * 100;
      row["__actual"] = cumActual * 100;
      out.push(row);
    }
    return out;
  }, [data, metric]);

  // RISK mode — server-side rolling Euler decomposition. Each day's
  // pctVarianceContrib + idioShare sum to ~100% by construction. NaN
  // inside burn-in / on rolling-fit failures. We only emit the visible
  // suffix `[displayStartIndex, n)`; with extended history the burn-in
  // typically falls before this slice and never appears on screen.
  const riskChartData = useMemo(() => {
    if (!data || metric !== "risk") return [];
    const { dates, factorMeta, rollingPctVarianceContrib, rollingIdioShare, rollingTotalVolAnn, displayStartIndex } = data;
    const out: Record<string, number | string | null>[] = [];
    for (let i = displayStartIndex; i < dates.length; i++) {
      const idio = rollingIdioShare[i];
      if (idio == null || !Number.isFinite(idio)) {
        // Burn-in or failed fit — emit null so chart leaves a gap.
        const row: Record<string, number | string | null> = { date: dates[i]! };
        for (const m of factorMeta) row[m.code] = null;
        row["__idio"] = null;
        row["__totalVol"] = null;
        out.push(row);
        continue;
      }
      const row: Record<string, number | string | null> = { date: dates[i]! };
      for (const m of factorMeta) {
        const v = rollingPctVarianceContrib[m.code]?.[i];
        row[m.code] = v == null || !Number.isFinite(v) ? 0 : v * 100;
      }
      row["__idio"] = idio * 100;
      row["__totalVol"] = rollingTotalVolAnn[i] != null ? num(rollingTotalVolAnn[i]) * 100 : null;
      out.push(row);
    }
    return out;
  }, [data, metric]);

  // BETA mode — rolling β_t,f per factor. NaN inside burn-in / on
  // rolling-fit failures (recharts leaves a gap). Visible suffix only.
  const betaChartData = useMemo(() => {
    if (!data || metric !== "beta") return [];
    const { dates, factorMeta, rollingBetas, displayStartIndex } = data;
    const out: Record<string, number | string | null>[] = [];
    for (let i = displayStartIndex; i < dates.length; i++) {
      const row: Record<string, number | string | null> = { date: dates[i]! };
      for (const m of factorMeta) {
        const v = rollingBetas[m.code]?.[i];
        row[m.code] = v == null || !Number.isFinite(v) ? null : v;
      }
      out.push(row);
    }
    return out;
  }, [data, metric]);

  const tickFmt = (d: string) => d.slice(0, 7);

  // Burn-in only renders when it falls inside the visible chart slice
  // `[displayStartIndex, n)`. With extended-history loading this is rare
  // (only happens on the fallback path when the underlying factor series
  // is genuinely too short for `params.window + rollingWindow + buffer`).
  const burnInVisible =
    data != null && data.burnInIndex > data.displayStartIndex && data.dates.length > data.burnInIndex;
  const burnInDate = burnInVisible ? data!.dates[data!.burnInIndex]! : null;
  const burnInStartDate = burnInVisible ? data!.dates[data!.displayStartIndex]! : null;
  const visibleObs = data ? Math.max(0, data.windowUsed - data.displayStartIndex) : 0;

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
      }}
    >
      <div
        style={{
          padding: "8px 14px",
          borderBottom: "1px solid var(--bg-border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={headerStyle}>
          {ticker} · Factor Time Series
          {data && (
            <span style={{ marginLeft: 8, color: "var(--text-secondary)", fontWeight: 500 }}>
              · rolling W = {data.rollingWindow}d · display W = {snapshotWindow}d · visible{" "}
              {visibleObs}d
            </span>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ ...headerStyle, fontWeight: 500, color: "var(--text-secondary)" }}>
            Rolling β
          </span>
          <div style={{ display: "inline-flex" }}>
            <MetricPill
              label="30d"
              active={rollingWindowSelection === 30}
              onClick={() => onRollingWindowSelectionChange(30)}
            />
            <MetricPill
              label="60d"
              active={rollingWindowSelection === 60}
              onClick={() => onRollingWindowSelectionChange(60)}
            />
            <MetricPill
              label="90d"
              active={rollingWindowSelection === 90}
              onClick={() => onRollingWindowSelectionChange(90)}
            />
            <MetricPill
              label="252d"
              active={rollingWindowSelection === 252}
              onClick={() => onRollingWindowSelectionChange(252)}
            />
            <MetricPill
              label="Match"
              active={rollingWindowSelection === "match"}
              onClick={() => onRollingWindowSelectionChange("match")}
            />
          </div>
        </div>
        <div style={{ display: "inline-flex" }}>
          <MetricPill label="Returns" active={metric === "return"} onClick={() => onMetricChange("return")} />
          <MetricPill label="Risk" active={metric === "risk"} onClick={() => onMetricChange("risk")} />
          <MetricPill label="Beta" active={metric === "beta"} onClick={() => onMetricChange("beta")} />
        </div>
      </div>

      <div style={{ padding: "8px 12px 12px" }}>
        {loading && (
          <div
            style={{
              height: 220,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-muted)",
              fontSize: 12,
            }}
          >
            Loading factor time series…
          </div>
        )}

        {!loading && data && metric === "return" && returnChartData.length > 0 && (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={returnChartData} margin={{ left: -10, right: 8 }}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 9, fill: "var(--text-secondary)" }}
                tickFormatter={tickFmt}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 9, fill: "var(--text-secondary)" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v.toFixed(0)}%`}
              />
              <ReferenceLine y={0} stroke="var(--bg-border)" />
              {burnInStartDate && burnInDate && (
                <ReferenceArea
                  x1={burnInStartDate}
                  x2={burnInDate}
                  fill="rgba(255,255,255,0.05)"
                  stroke="none"
                  ifOverflow="hidden"
                />
              )}
              {burnInDate && (
                <ReferenceLine
                  x={burnInDate}
                  stroke="var(--text-muted)"
                  strokeDasharray="3 3"
                  label={{
                    value: `t = W (${data.rollingWindow}d)`,
                    position: "insideTopLeft",
                    fill: "var(--text-muted)",
                    fontSize: 9,
                  }}
                />
              )}
              <Tooltip
                contentStyle={bbTooltipStyle}
                formatter={(v, name) => [
                  `${Number(v ?? 0).toFixed(2)}%`,
                  name === "__alpha"
                    ? "Σ rolling α_t"
                    : name === "__residual"
                      ? "Unexplained Residual"
                      : name === "__actual"
                        ? "Realised excess (cumulative)"
                        : getFactorDef(name as FactorCode).shortLabel,
                ]}
                labelFormatter={(d) => String(d).slice(0, 10)}
              />
              <Legend
                wrapperStyle={{ fontSize: 10 }}
                formatter={(v) =>
                  v === "__alpha"
                    ? "Σ rolling α_t"
                    : v === "__residual"
                      ? "Unexplained Residual"
                      : v === "__actual"
                        ? "Realised excess"
                        : getFactorDef(v as FactorCode).shortLabel
                }
              />
              {data.factorMeta.map((m) => (
                <Area
                  key={m.code}
                  type="monotone"
                  dataKey={m.code}
                  stroke={m.color}
                  fill={`${m.color}40`}
                  strokeWidth={1.2}
                  dot={false}
                  stackId="ret"
                />
              ))}
              <Area
                type="monotone"
                dataKey="__alpha"
                stroke="#f1f5f9"
                fill="rgba(241,245,249,0.18)"
                strokeWidth={1.2}
                strokeDasharray="3 2"
                dot={false}
                stackId="ret"
              />
              <Area
                type="monotone"
                dataKey="__residual"
                stroke="#94a3b8"
                fill="rgba(148,163,184,0.15)"
                strokeWidth={1}
                dot={false}
                stackId="ret"
              />
              <Line
                type="monotone"
                dataKey="__actual"
                stroke="#f0b65d"
                strokeWidth={1.6}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}

        {!loading && data && metric === "risk" && riskChartData.length > 0 && (
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={riskChartData} margin={{ left: -10, right: 8 }}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 9, fill: "var(--text-secondary)" }}
                tickFormatter={tickFmt}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 9, fill: "var(--text-secondary)" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v.toFixed(0)}%`}
                domain={[0, 100]}
              />
              {burnInStartDate && burnInDate && (
                <ReferenceArea
                  x1={burnInStartDate}
                  x2={burnInDate}
                  fill="rgba(255,255,255,0.05)"
                  stroke="none"
                  ifOverflow="hidden"
                />
              )}
              {burnInDate && (
                <ReferenceLine
                  x={burnInDate}
                  stroke="var(--text-muted)"
                  strokeDasharray="3 3"
                  label={{
                    value: `t = W`,
                    position: "insideTopLeft",
                    fill: "var(--text-muted)",
                    fontSize: 9,
                  }}
                />
              )}
              <Tooltip
                contentStyle={bbTooltipStyle}
                formatter={(v, name, item) => {
                  const totalVol =
                    item && (item.payload as { __totalVol?: number | null }).__totalVol;
                  const suffix = totalVol != null && Number.isFinite(totalVol)
                    ? ` · σ ${Number(totalVol).toFixed(1)}%`
                    : "";
                  const lbl = name === "__idio"
                    ? "Idiosyncratic"
                    : getFactorDef(name as FactorCode).shortLabel;
                  return [`${Number(v ?? 0).toFixed(1)}%${suffix}`, lbl];
                }}
                labelFormatter={(d) => String(d).slice(0, 10)}
              />
              <Legend
                wrapperStyle={{ fontSize: 10 }}
                formatter={(v) =>
                  v === "__idio" ? "Idiosyncratic" : getFactorDef(v as FactorCode).shortLabel
                }
              />
              {data.factorMeta.map((m) => (
                <Area
                  key={m.code}
                  type="monotone"
                  dataKey={m.code}
                  stroke={m.color}
                  fill={`${m.color}40`}
                  strokeWidth={1.2}
                  dot={false}
                  stackId="risk"
                  connectNulls={false}
                />
              ))}
              <Area
                type="monotone"
                dataKey="__idio"
                stroke="#94a3b8"
                fill="rgba(148,163,184,0.25)"
                strokeWidth={1.2}
                dot={false}
                stackId="risk"
                connectNulls={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}

        {!loading && data && metric === "beta" && betaChartData.length > 0 && (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={betaChartData} margin={{ left: -10, right: 8 }}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 9, fill: "var(--text-secondary)" }}
                tickFormatter={tickFmt}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 9, fill: "var(--text-secondary)" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => v.toFixed(2)}
              />
              <ReferenceLine y={0} stroke="var(--bg-border)" strokeDasharray="2 2" />
              {burnInStartDate && burnInDate && (
                <ReferenceArea
                  x1={burnInStartDate}
                  x2={burnInDate}
                  fill="rgba(255,255,255,0.05)"
                  stroke="none"
                  ifOverflow="hidden"
                />
              )}
              {burnInDate && (
                <ReferenceLine
                  x={burnInDate}
                  stroke="var(--text-muted)"
                  strokeDasharray="3 3"
                  label={{
                    value: `t = W`,
                    position: "insideTopLeft",
                    fill: "var(--text-muted)",
                    fontSize: 9,
                  }}
                />
              )}
              <Tooltip
                contentStyle={bbTooltipStyle}
                formatter={(v, name) => [
                  Number(v ?? 0).toFixed(3),
                  getFactorDef(name as FactorCode).shortLabel,
                ]}
                labelFormatter={(d) => String(d).slice(0, 10)}
              />
              <Legend
                wrapperStyle={{ fontSize: 10 }}
                formatter={(v) => getFactorDef(v as FactorCode).shortLabel}
              />
              {data.factorMeta.map((m) => (
                <Line
                  key={m.code}
                  type="monotone"
                  dataKey={m.code}
                  stroke={m.color}
                  strokeWidth={1.4}
                  dot={false}
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}

        {!loading && (!data || (metric === "return" && returnChartData.length === 0)) && (
          <div
            style={{
              height: 220,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-muted)",
              fontSize: 12,
              textAlign: "center",
              padding: 12,
            }}
          >
            Not enough overlap between this stock&apos;s prices and the factor data for the selected
            window. Try a longer window or refresh the factor pipeline.
          </div>
        )}

        {data && (data.rollingFitFailures > 0 || data.droppedDates.length > 0) && (
          <div
            style={{
              marginTop: 6,
              padding: "6px 10px",
              fontSize: 10,
              fontFamily: "var(--font-mono, monospace)",
              color: "var(--color-warning, #f59e0b)",
              background: "rgba(245,158,11,0.06)",
              border: "1px solid rgba(245,158,11,0.25)",
            }}
            title={
              `${data.rollingFitFailures} rolling-fit failure(s)\n` +
              `${data.droppedDates.length} (date × factor) cells dropped from this stock's regression matrix because of missing factor data.\n\n` +
              `Phase 3 lock-in: missing rows are dropped (no silent zero-fill); failed fits skip from cumulative sums (no silent (α=0, ε=y) fallback).`
            }
          >
            ⚠ {data.rollingFitFailures > 0 && `${data.rollingFitFailures} rolling-fit failure(s)`}
            {data.rollingFitFailures > 0 && data.droppedDates.length > 0 && " · "}
            {data.droppedDates.length > 0 && `${data.droppedDates.length} factor cell(s) dropped (strict)`}
          </div>
        )}
      </div>
    </div>
  );
}
