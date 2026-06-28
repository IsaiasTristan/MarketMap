"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { DiscoveryRow } from "./types";
import { clampValue, robustDomain } from "@/lib/fundamental/robust-domain";

interface Pt {
  ticker: string;
  companyName: string;
  x: number; // cheapness (value)
  y: number; // compounder score (quality) — true value, shown in tooltip
  yPlot: number; // clamped to the robust domain for drawing
  trap: boolean;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function QualityValueScatter({
  rows,
  onSelectTicker,
}: {
  rows: DiscoveryRow[];
  onSelectTicker: (t: string) => void;
}) {
  const { good, traps, mx, my, yDomain } = useMemo(() => {
    const raw = rows
      .filter((r) => r.cheapness != null && r.compounderScore != null)
      .map((r) => ({
        ticker: r.ticker,
        companyName: r.companyName,
        x: r.cheapness as number,
        y: r.compounderScore as number,
        trap: r.trapFlag,
      }));
    // Clip the quality axis so a single blowout name can't flatten everyone else.
    const dom = robustDomain(raw.map((p) => p.y));
    const pts: Pt[] = raw.map((p) => ({
      ...p,
      yPlot: dom ? clampValue(p.y, dom[0], dom[1]) : p.y,
    }));
    return {
      good: pts.filter((p) => !p.trap),
      traps: pts.filter((p) => p.trap),
      mx: median(pts.map((p) => p.x)),
      my: median(pts.map((p) => p.yPlot)),
      yDomain: dom,
    };
  }, [rows]);

  if (good.length + traps.length === 0) {
    return <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>No quality/value data yet.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
        Quality (compounder = ROIC level × consistency) vs Value (cheapness = 1 − mean valuation percentile vs own
        history). Top-right = high-quality &amp; cheap. Red = accruals trap flag. Click a point to diligence.
      </div>
      <div style={{ height: 420, background: "var(--bg-surface)", padding: 6 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 12, right: 18, bottom: 24, left: 4 }}>
            <CartesianGrid stroke="var(--chrome-border)" strokeDasharray="2 2" />
            <XAxis
              type="number"
              dataKey="x"
              name="Cheapness"
              tick={{ fontSize: 9, fill: "var(--text-muted)" }}
              label={{ value: "Cheaper vs own history →", position: "bottom", fontSize: 10, fill: "var(--text-muted)" }}
            />
            <YAxis
              type="number"
              dataKey="yPlot"
              name="Quality"
              {...(yDomain ? { domain: yDomain, allowDataOverflow: true } : {})}
              tick={{ fontSize: 9, fill: "var(--text-muted)" }}
              label={{ value: "Higher quality →", angle: -90, position: "left", fontSize: 10, fill: "var(--text-muted)" }}
            />
            <ZAxis range={[36, 36]} />
            <ReferenceLine x={mx} stroke="var(--chrome-border)" />
            <ReferenceLine y={my} stroke="var(--chrome-border)" />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              content={({ payload }) => {
                const p = payload?.[0]?.payload as Pt | undefined;
                if (!p) return null;
                return (
                  <div style={{ background: "var(--bg-base)", border: "1px solid var(--chrome-border)", fontSize: 11, padding: 6 }}>
                    <div style={{ color: "var(--color-accent)", fontWeight: 700 }}>{p.ticker}{p.trap ? " · TRAP" : ""}</div>
                    <div style={{ color: "var(--text-muted)" }}>{p.companyName}</div>
                    <div>quality {p.y.toFixed(3)} · value {p.x.toFixed(2)}</div>
                  </div>
                );
              }}
            />
            <Scatter name="Names" data={good} fill="var(--color-positive)" onClick={(p) => onSelectTicker((p as unknown as Pt).ticker)} />
            <Scatter name="Trap" data={traps} fill="var(--bb-red)" onClick={(p) => onSelectTicker((p as unknown as Pt).ticker)} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
