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
import { expSumMinus1 } from "@/lib/factors/attribution/log-returns";
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
  /** Path B (log-return) parallel attribution series. Null when unavailable. */
  log: {
    excessLogReturn: number[];
    alphaLog: (number | null)[];
    residualLog: (number | null)[];
    predictedLog: (number | null)[];
    factorLogContrib: Record<string, (number | null)[]>;
    betasLog: Record<string, number>;
    rollingBetasLog: Record<string, (number | null)[]>;
    rollingFitFailures: number;
    sumLogExcessVisible: number;
    sumLogDecomposedVisible: number;
    geometricExcessVisible: number;
    /**
     * `Σ ln(1 + r_stock_i)` over `[displayStartIndex, n)`. UI consumers
     * compute `exp(sumLogTotalVisible) − 1` to display a compounded
     * geometric TOTAL return that's directly comparable to broker /
     * Google "1Y return" figures (excess + RF compounded). Falls back
     * to the excess sum if any visible day has `1 + r_stock ≤ 0`.
     */
    sumLogTotalVisible: number;
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
  // Path B is the new default surface. We use log space whenever the server
  // can provide it (data.log != null); strict-drop fallback (e.g. a daily
  // simple return ≤ -100% in this window) silently degrades to Path A so
  // the user still sees something — with explicit warnings owned by the
  // PerStockDetail panel above.
  const useLog = data?.log != null;
  // RETURN mode — cumulative stack (factors + Σα + Σε) overlaid by the
  // realised cumulative excess. We start cumulating from `displayStartIndex`
  // so the chart begins at zero on the first visible day (otherwise the
  // cumulative contributions accumulated during the unseen extended-history
  // period would appear as a non-zero offset at t₀ and break the identity).
  //
  // Log mode (default when data.log is present):
  //   - factor / alpha / residual stacks are PLOTTED in log space ×100. The
  //     stack closes on a thin dashed reference line `__cumLog` (Σ y_log×100)
  //     — that is the LOG identity Σy_log = Σ(β·x_log)+Σα+Σε.
  //   - `__actual` is the GEOMETRIC realised path exp(Σ y_log)−1 ×100. This
  //     is the line whose right edge ties to the panel's headline number
  //     (which is the same exp(Σ)−1 evaluated at the last visible day).
  //   - The two realised lines visibly diverge over the window — that gap is
  //     the convexity adjustment (geometric > arithmetic for positive return
  //     paths; reversed for negative). We label both clearly.
  //
  // Simple mode (fallback only when log path was strict-dropped):
  //   - `__actual` plots Σ y_simple ×100 (legacy arithmetic path); stack
  //     closes onto it directly. `__cumLog` is omitted.
  const returnChartData = useMemo(() => {
    if (!data || metric !== "return") return [];
    const { dates, factorMeta, displayStartIndex } = data;
    const factorContrib = useLog ? data.log!.factorLogContrib : data.factorContrib;
    const alpha = useLog ? data.log!.alphaLog : data.alpha;
    const residual = useLog ? data.log!.residualLog : data.residual;
    const excess = useLog ? data.log!.excessLogReturn : data.excessReturn;
    const cumFactor: Record<string, number> = {};
    let cumAlpha = 0;
    let cumResid = 0;
    let cumExcessInner = 0;
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
      cumExcessInner += excess[i] ?? 0;
      row["__alpha"] = cumAlpha * 100;
      row["__residual"] = cumResid * 100;
      if (useLog) {
        // Log mode: realised = geometric path; reference = inner log sum
        // (where the factor/alpha/residual stack closes by identity).
        row["__actual"] = (Math.exp(cumExcessInner) - 1) * 100;
        row["__cumLog"] = cumExcessInner * 100;
      } else {
        row["__actual"] = cumExcessInner * 100;
      }
      out.push(row);
    }
    return out;
  }, [data, metric, useLog]);

  const logHeadline = useMemo(() => {
    if (!data?.log || metric !== "return") return null;
    const { dates, displayStartIndex } = data;
    let sum = 0;
    for (let i = displayStartIndex; i < dates.length; i++) {
      sum += data.log.excessLogReturn[i] ?? 0;
    }
    return {
      sumLog: sum,
      geometric: expSumMinus1(sum),
    };
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
  // Denominator the user requested. Clamps to `visibleObs` when the
  // visible region is fully populated (so we don't show "252 / 252d"
  // truncated to e.g. "240 / 252" when the slack is just the burn-in
  // overlap with the display window).
  const visibleDenominator = Math.max(visibleObs, snapshotWindow);
  const visibleShort = visibleObs < visibleDenominator;
  const visibleHover = visibleShort
    ? `${visibleDenominator - visibleObs} trading day(s) dropped from the requested ${visibleDenominator}-day display window. ` +
      "Strict drop-row policy: dates with any missing factor cell are removed " +
      "(see scripts/factor-window-coverage.ts)."
    : `Full ${visibleDenominator}-day display window populated.`;

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
              <span
                title={visibleHover}
                style={{
                  cursor: "help",
                  color: visibleShort ? "var(--accent-amber, #f0b65d)" : "inherit",
                }}
              >
                {visibleObs} / {visibleDenominator}d
              </span>
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
                    ? useLog
                      ? "Σ α_t (log)"
                      : "Σ rolling α_t"
                    : name === "__residual"
                      ? useLog
                        ? "Σ ε_t (log)"
                        : "Unexplained Residual"
                      : name === "__actual"
                        ? useLog
                          ? "Realised excess (compounded)"
                          : "Realised excess (arithmetic)"
                        : name === "__cumLog"
                          ? "Σ y_log (stack closes here)"
                          : getFactorDef(name as FactorCode).shortLabel,
                ]}
                labelFormatter={(d) => String(d).slice(0, 10)}
              />
              <Legend
                wrapperStyle={{ fontSize: 10 }}
                formatter={(v) =>
                  v === "__alpha"
                    ? useLog
                      ? "Σ α_t (log)"
                      : "Σ rolling α_t"
                    : v === "__residual"
                      ? useLog
                        ? "Σ ε_t (log)"
                        : "Unexplained Residual"
                      : v === "__actual"
                        ? useLog
                          ? "Realised (compounded)"
                          : "Realised excess"
                        : v === "__cumLog"
                          ? "Σ y_log (stack closes)"
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
              {/* Inner log sum line — only in log mode. The factor stack +
                  Σα + Σε close exactly on this line by the daily log identity.
                  Drawn thin & dashed so it doesn't compete with the heavier
                  realised compounded line. */}
              {useLog && (
                <Line
                  type="monotone"
                  dataKey="__cumLog"
                  stroke="#cbd5e1"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                  dot={false}
                  isAnimationActive={false}
                />
              )}
              {/* Realised excess line — the heavy one. In log mode this is the
                  GEOMETRIC compounded path exp(Σ y_log) − 1 whose right edge
                  ties to the panel's headline number. In simple-fallback mode
                  this is Σ y_simple (arithmetic). */}
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

        {!loading && data && metric === "return" && useLog && logHeadline && (
          <div
            style={{
              marginTop: 6,
              padding: "5px 10px",
              fontSize: 9,
              fontFamily: "var(--font-mono, monospace)",
              fontVariantNumeric: "tabular-nums",
              color: "var(--text-muted)",
              display: "flex",
              gap: 14,
              flexWrap: "wrap",
            }}
            title={
              `Two realised lines are plotted in log mode:\n\n` +
              `  • Heavy gold line — Realised (compounded): exp(Σ y_log) − 1 per day; ` +
              `right edge ties to the panel's "Total Excess Return" headline.\n\n` +
              `  • Thin dashed line — Σ y_log (stack closes): the additive inner log sum where ` +
              `factor + α + ε stacks close exactly by daily identity.\n\n` +
              `The gap between the two lines is the convexity adjustment (geometric > arithmetic ` +
              `for positive return paths). Both lines start at zero on the first visible day.`
            }
          >
            <span>
              <span style={{ color: "var(--bb-amber, #f0b65d)" }}>━</span>{" "}
              Realised (compounded) end ={" "}
              <span style={{ color: "var(--color-positive)", fontWeight: 600 }}>
                {(logHeadline.geometric * 100).toFixed(2)}%
              </span>
            </span>
            <span>
              <span style={{ color: "#cbd5e1" }}>┄</span>{" "}
              Σ y_log end = {(logHeadline.sumLog * 100).toFixed(2)}% (stack closes here)
            </span>
          </div>
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
