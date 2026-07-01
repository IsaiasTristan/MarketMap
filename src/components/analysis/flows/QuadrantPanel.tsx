"use client";
/** 5.2 Crowding-vs-conviction 2×2 — the highest-value view. Raw axes; position is the decision. */
import { CartesianGrid, Cell, ReferenceArea, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import type { QuadrantPayload, QuadrantPoint } from "@/server/services/institutional/institutional-query.service";
import { useFlows } from "./useFlows";
import { PanelState, QUADRANT_COLOR, QUADRANT_LABEL, CapTag, fmtDelta } from "./flowsUi";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";

type PlotPoint = QuadrantPoint & { z: number; convictionRaw: number | null; clamped: boolean };

function QuadTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: PlotPoint }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  // Show the TRUE conviction (the plotted y is clamped to the axis cap for outliers).
  const conv = p.convictionRaw;
  return (
    <div style={{ ...bbTooltipStyle, padding: "6px 8px" }}>
      <div style={{ fontWeight: 700 }}>{p.ticker} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>{p.companyName ?? ""}</span></div>
      <div style={{ color: "var(--text-muted)" }}>{p.sector} · {p.marketCapTier ?? "?"}</div>
      <div>breadth {p.breadth.toFixed(1)}% of funds · {p.fundsHolding} hold</div>
      <div>conviction {conv === null ? "—" : `${conv.toFixed(2)}% of book`}{p.clamped ? " ▲ (off-scale)" : ""}</div>
      <div>Δ holders {fmtDelta(p.deltaHolders)} · {p.quadrant ? QUADRANT_LABEL[p.quadrant] : ""}</div>
    </div>
  );
}

export function QuadrantPanel({ period, onSelectTicker }: { period: string | null; onSelectTicker: (t: string) => void }) {
  const { data, state, error } = useFlows<QuadrantPayload>(["flows-quadrant", period], `/api/analysis/flows/quadrant?minFunds=2${period ? `&period=${period}` : ""}`);

  // Finite axis maxima — recharts cannot map Infinity, so the quadrant shading
  // must be bounded by real domain extents, not Infinity.
  const pts = data?.points ?? [];
  const xMax = Number((Math.max(data?.breadthLine ?? 25, ...pts.map((p) => p.breadth), 1) * 1.03).toFixed(1));
  // Conviction is heavily right-skewed: a few 2-fund micro names sit at 10–15% of
  // book while the median is a fraction of a percent. Using the raw max blows the
  // y-axis out so the mass of names collapses into an unreadable smear on the x-axis.
  // Clamp the domain to a high percentile (p96) and PIN the few true outliers to the
  // top edge — the tooltip still reports their real conviction.
  const convVals = pts.map((p) => p.conviction ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
  const convP96 = convVals.length ? convVals[Math.min(convVals.length - 1, Math.floor(convVals.length * 0.96))]! : 0;
  const yMax = Number((Math.max(convP96, (data?.convictionLine ?? 0) * 2, 0.5) * 1.06).toFixed(2));
  const scatterData: PlotPoint[] = pts.map((p) => {
    const raw = p.conviction;
    return {
      ...p,
      z: Math.abs(p.deltaHolders) + 1,
      convictionRaw: raw,
      clamped: (raw ?? 0) > yMax,
      conviction: Math.min(raw ?? 0, yMax), // plotted y — clamped so outliers stay on-canvas
    };
  });
  const clampedCount = scatterData.filter((p) => p.clamped).length;

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            x = breadth (% of tracked funds holding) · y = conviction (median % of fund book) · bubble = |Δ holders| ·
            <span style={{ color: "var(--color-positive)" }}> green early</span>,
            <span style={{ color: "var(--color-accent)" }}> amber crowded</span>,
            <span style={{ color: "var(--text-muted)" }}> gray static</span>. This view kills crowded late trades as visibly as it surfaces early ones.
          </div>
          <div style={{ width: "100%", height: 460, background: "var(--bg-surface)", border: "1px solid var(--bg-border)" }}>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 16, right: 24, bottom: 30, left: 10 }} onClick={(state) => {
                const pt = (state as unknown as { activePayload?: Array<{ payload: QuadrantPoint }> })?.activePayload?.[0]?.payload;
                if (pt) onSelectTicker(pt.ticker);
              }}>
                <CartesianGrid stroke="var(--bg-border)" strokeDasharray="2 4" />
                {/* Quadrant background shading (early = upper-left green, crowded = upper-right amber). */}
                <ReferenceArea x1={0} x2={data.breadthLine} y1={data.convictionLine} y2={yMax} fill="var(--color-positive)" fillOpacity={0.05} />
                <ReferenceArea x1={data.breadthLine} x2={xMax} y1={data.convictionLine} y2={yMax} fill="var(--color-accent)" fillOpacity={0.06} />
                <ReferenceLine x={data.breadthLine} stroke="var(--text-muted)" strokeDasharray="3 3" label={{ value: `${data.breadthLine}% breadth`, position: "top", fill: "var(--text-muted)", fontSize: 10 }} />
                <ReferenceLine y={data.convictionLine} stroke="var(--text-muted)" strokeDasharray="3 3" label={{ value: "median conviction", position: "insideTopRight", fill: "var(--text-muted)", fontSize: 10 }} />
                <XAxis type="number" dataKey="breadth" name="breadth" unit="%" domain={[0, xMax]} tick={{ fontSize: 10, fill: "var(--text-secondary)" }} tickLine={false} label={{ value: "Breadth — % of tracked funds holding →", position: "bottom", fill: "var(--text-secondary)", fontSize: 10 }} />
                <YAxis type="number" dataKey="conviction" name="conviction" unit="%" domain={[0, yMax]} tick={{ fontSize: 10, fill: "var(--text-secondary)" }} tickLine={false} width={44} label={{ value: "Conviction — median % of book ↑", angle: -90, position: "insideLeft", fill: "var(--text-secondary)", fontSize: 10 }} />
                <ZAxis type="number" dataKey="z" range={[14, 260]} />
                <Tooltip content={<QuadTooltip />} cursor={{ strokeDasharray: "3 3" }} />
                <Scatter data={scatterData} fillOpacity={0.55}>
                  {scatterData.map((p) => (
                    <Cell
                      key={p.ticker}
                      fill={QUADRANT_COLOR[p.quadrant ?? "ignored"] ?? "#555"}
                      // Pinned outliers get a bright outline so it's clear they sit above the axis cap.
                      stroke={p.clamped ? "var(--text-primary)" : "none"}
                      strokeWidth={p.clamped ? 1 : 0}
                    />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
            Upper-left = early conviction (edge lives here) · upper-right = crowded / late-trade risk. Click any bubble for its fund ledger.
            {" "}Breadth is discrete — each column is one more of the {data.trackedFunds} tracked funds (quant/index-like books excluded).
            {clampedCount > 0 && (
              <> Conviction axis is capped at {yMax}% for readability; {clampedCount} high-conviction outlier{clampedCount === 1 ? "" : "s"} (outlined) sit above it — hover for the true value.</>
            )}
          </div>
        </div>
      )}
    </PanelState>
  );
}
