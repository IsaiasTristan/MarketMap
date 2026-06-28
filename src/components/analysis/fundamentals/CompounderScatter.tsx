"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
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
  x: number; // consistency
  y: number; // ROIC level — true value, shown in tooltip
  yPlot: number; // clamped to the robust domain for drawing
  trap: boolean;
}

export function CompounderScatter({
  rows,
  onSelectTicker,
}: {
  rows: DiscoveryRow[];
  onSelectTicker: (t: string) => void;
}) {
  const { good, traps, yDomain } = useMemo(() => {
    const raw = rows
      .filter((r) => r.compounderConsistency != null && r.compounderLevel != null)
      .map((r) => ({
        ticker: r.ticker,
        companyName: r.companyName,
        x: r.compounderConsistency as number,
        y: r.compounderLevel as number,
        trap: r.trapFlag,
      }));
    // Clip the ROIC axis so a near-zero-capital blowout can't flatten everyone else.
    const dom = robustDomain(raw.map((p) => p.y));
    const pts: Pt[] = raw.map((p) => ({
      ...p,
      yPlot: dom ? clampValue(p.y, dom[0], dom[1]) : p.y,
    }));
    return { good: pts.filter((p) => !p.trap), traps: pts.filter((p) => p.trap), yDomain: dom };
  }, [rows]);

  if (good.length + traps.length === 0) {
    return <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>No compounder data yet.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
        Durable quality: ROIC level (y) vs consistency (x = 1 / (1 + ROIC dispersion)). Top-right = high &amp; stable
        ROIC — the compounders. Click a point to diligence.
      </div>
      <div style={{ height: 420, background: "var(--bg-surface)", padding: 6 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 12, right: 18, bottom: 24, left: 4 }}>
            <CartesianGrid stroke="var(--chrome-border)" strokeDasharray="2 2" />
            <XAxis
              type="number"
              dataKey="x"
              name="Consistency"
              domain={[0, 1]}
              tick={{ fontSize: 9, fill: "var(--text-muted)" }}
              label={{ value: "More consistent →", position: "bottom", fontSize: 10, fill: "var(--text-muted)" }}
            />
            <YAxis
              type="number"
              dataKey="yPlot"
              name="ROIC"
              {...(yDomain ? { domain: yDomain, allowDataOverflow: true } : {})}
              tick={{ fontSize: 9, fill: "var(--text-muted)" }}
              label={{ value: "ROIC level →", angle: -90, position: "left", fontSize: 10, fill: "var(--text-muted)" }}
            />
            <ZAxis range={[36, 36]} />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              content={({ payload }) => {
                const p = payload?.[0]?.payload as Pt | undefined;
                if (!p) return null;
                return (
                  <div style={{ background: "var(--bg-base)", border: "1px solid var(--chrome-border)", fontSize: 11, padding: 6 }}>
                    <div style={{ color: "var(--color-accent)", fontWeight: 700 }}>{p.ticker}{p.trap ? " · TRAP" : ""}</div>
                    <div style={{ color: "var(--text-muted)" }}>{p.companyName}</div>
                    <div>ROIC {(p.y * 100).toFixed(1)}% · consistency {p.x.toFixed(2)}</div>
                  </div>
                );
              }}
            />
            <Scatter name="Names" data={good} fill="var(--color-accent)" onClick={(p) => onSelectTicker((p as unknown as Pt).ticker)} />
            <Scatter name="Trap" data={traps} fill="var(--bb-red)" onClick={(p) => onSelectTicker((p as unknown as Pt).ticker)} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
