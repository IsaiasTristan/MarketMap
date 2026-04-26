"use client";
/**
 * Predicted vs actual excess return — one point per trading day in the
 * regression window POST burn-in. y = x (amber) is perfect in-sample fit;
 * dashed white is OLS of predicted on actual (slope, R², RMSE).
 *
 * Phase 3 lock-ins (2026-04-25):
 *   • Card title: "Rolling-Prediction Fit" (Q10 lock).
 *   • Overlay shows BOTH `Rolling R²` (this scatter, on rolling
 *     predictions) AND `Static R² (in-sample)` (snapshot OLS over the
 *     same window). They differ when rolling betas drift inside the
 *     window — the gap is itself a model-stability signal.
 *   • Burn-in days are excluded — points only render for
 *     i ≥ displayStartIndex.
 *   • Slope explanation is a visible caption (not just a hover hint):
 *     "Slope b = X.XXX (b ≤ 1 expected on rolling OLS — regression dilution)".
 */
import { useMemo } from "react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import type { PerStockTimeSeriesPayload } from "./PerStockTimeSeries";

interface PredictedActualScatterProps {
  data: PerStockTimeSeriesPayload | null;
  /** Static (in-sample, full-window) R² from the snapshot regression. */
  staticRSquared: number | null;
  loading?: boolean;
}

type Point = { date: string; x: number; y: number };

function olsPredictedOnActual(points: Point[]): {
  a: number;
  b: number;
  r2: number;
  rmse: number;
  lo: number;
  hi: number;
} | null {
  const n = points.length;
  if (n < 3) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    num += dx * (ys[i]! - my);
    den += dx * dx;
  }
  const b = den > 1e-20 ? num / den : 0;
  const a = my - b * mx;
  let sst = 0;
  let ssr = 0;
  for (let i = 0; i < n; i++) {
    sst += (ys[i]! - my) ** 2;
    const yhat = a + b * xs[i]!;
    ssr += (ys[i]! - yhat) ** 2;
  }
  const r2 = sst > 1e-20 ? 1 - ssr / sst : 0;
  const rmse = Math.sqrt(ssr / n);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const lo = Math.min(minX, minY);
  const hi = Math.max(maxX, maxY);
  const pad = (hi - lo) * 0.06 || 0.005;
  return { a, b, r2, rmse, lo: lo - pad, hi: hi + pad };
}

export function PredictedActualScatter({ data, staticRSquared, loading }: PredictedActualScatterProps) {
  const points = useMemo((): Point[] => {
    if (!data?.actual?.length || !data.predicted?.length) return [];
    const startIdx = data.displayStartIndex ?? 0;
    const n = Math.min(data.actual.length, data.predicted.length, data.dates.length);
    const out: Point[] = [];
    for (let i = startIdx; i < n; i++) {
      const yhat = data.predicted[i];
      const yval = data.actual[i];
      // Skip burn-in (predicted=null) and rolling-fit failures (predicted=null).
      if (yhat == null || !Number.isFinite(yhat)) continue;
      if (yval == null || !Number.isFinite(yval)) continue;
      out.push({
        date: data.dates[i]!,
        x: yval,
        y: yhat,
      });
    }
    return out;
  }, [data]);

  const fit = useMemo(() => olsPredictedOnActual(points), [points]);

  const tickPct = (v: number) => `${(v * 100).toFixed(1)}%`;

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        position: "relative",
      }}
    >
      <div
        style={{
          padding: "8px 14px",
          borderBottom: "1px solid var(--bg-border)",
          fontSize: 10,
          fontWeight: 700,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Rolling-Prediction Fit (daily excess return)
      </div>

      {loading && (
        <div
          style={{
            height: 260,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          Loading…
        </div>
      )}

      {!loading && points.length > 0 && fit && (
        <>
          <div
            style={{
              position: "absolute",
              top: 44,
              right: 12,
              zIndex: 2,
              fontSize: 10,
              fontFamily: "var(--font-mono, monospace)",
              color: "var(--text-secondary)",
              textAlign: "right",
              lineHeight: 1.45,
              pointerEvents: "none",
            }}
          >
            <div>
              Rolling R² ={" "}
              <span style={{ color: "var(--color-accent)" }}>{fit.r2.toFixed(3)}</span>
            </div>
            <div title="In-sample R² from the snapshot OLS over the same window. Differs from rolling R² when betas drift inside the window — gap = stability signal.">
              Static R² (in-sample) ={" "}
              <span style={{ color: "#cbd5e1" }}>
                {staticRSquared != null && Number.isFinite(staticRSquared) ? staticRSquared.toFixed(3) : "—"}
              </span>
            </div>
            <div>Slope = {fit.b.toFixed(3)}</div>
            <div>RMSE = {(fit.rmse * 100).toFixed(3)}% (daily)</div>
          </div>
          <div style={{ padding: "8px 12px 12px" }}>
            <ResponsiveContainer width="100%" height={260}>
              <ScatterChart margin={{ top: 8, right: 12, bottom: 8, left: 8 }}>
                <CartesianGrid strokeDasharray="2 2" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="Actual"
                  domain={[fit.lo, fit.hi]}
                  tick={{ fontSize: 9, fill: "var(--text-secondary)" }}
                  tickFormatter={tickPct}
                  label={{ value: "Actual excess return", position: "bottom", offset: 0, fill: "var(--text-muted)", fontSize: 10 }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="Predicted"
                  domain={[fit.lo, fit.hi]}
                  tick={{ fontSize: 9, fill: "var(--text-secondary)" }}
                  tickFormatter={tickPct}
                  label={{
                    value: "Predicted excess return",
                    angle: -90,
                    position: "insideLeft",
                    fill: "var(--text-muted)",
                    fontSize: 10,
                  }}
                />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  contentStyle={bbTooltipStyle}
                  formatter={(v, name) => [
                    `${(Number(v ?? 0) * 100).toFixed(3)}%`,
                    String(name),
                  ]}
                  labelFormatter={(_, payload) => {
                    const p = payload?.[0]?.payload as Point | undefined;
                    return p?.date?.slice(0, 10) ?? "";
                  }}
                />
                <ReferenceLine
                  segment={[
                    { x: fit.lo, y: fit.lo },
                    { x: fit.hi, y: fit.hi },
                  ]}
                  stroke="var(--color-accent)"
                  strokeWidth={1.5}
                  ifOverflow="visible"
                />
                <ReferenceLine
                  segment={[
                    { x: fit.lo, y: fit.a + fit.b * fit.lo },
                    { x: fit.hi, y: fit.a + fit.b * fit.hi },
                  ]}
                  stroke="#e2e8f0"
                  strokeWidth={1.2}
                  strokeDasharray="5 3"
                  ifOverflow="visible"
                />
                <Scatter data={points} fill="rgba(148,163,184,0.85)" name="Daily" />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <div
            style={{
              padding: "0 12px 10px",
              fontSize: 10,
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono, monospace)",
              lineHeight: 1.55,
            }}
          >
            <div>
              Amber: y = x (perfect fit). Dashed: OLS of predicted on actual. Each dot = one trading
              day post burn-in.
            </div>
            <div style={{ marginTop: 2, color: "var(--text-muted)" }}>
              Slope b = <span style={{ color: "var(--text-secondary)" }}>{fit.b.toFixed(3)}</span> ·
              b ≤ 1 expected on rolling OLS (regression dilution from low-DOF rolling windows).
              Compare Rolling R² vs Static R² above — gap = β instability inside the window.
            </div>
          </div>
        </>
      )}

      {!loading && points.length === 0 && (
        <div
          style={{
            height: 120,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-muted)",
            fontSize: 12,
            padding: 16,
          }}
        >
          Load time series data to see predicted vs actual scatter.
        </div>
      )}
    </div>
  );
}
