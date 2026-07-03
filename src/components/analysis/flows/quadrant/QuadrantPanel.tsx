"use client";
/**
 * 5.2 Crowding-vs-conviction — the highest-value view. Raw axes; position is
 * the decision. Two render layers: a signal FOREGROUND (meaningful holder
 * swings or established above-median-conviction names) and a context
 * BACKGROUND (everything else, small and gray, never hit-tested).
 */
import { useMemo, useState } from "react";
import type { QuadrantPayload } from "@/server/services/institutional/institutional-query.service";
import { useFlows } from "../useFlows";
import { PanelState, QUADRANT_LABEL, fmtDelta } from "../flowsUi";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import { buildQuadrantModel } from "./quadrantModel";
import { QuadrantChart, type HoverState } from "./QuadrantChart";
import { useMeasure } from "./useMeasure";

const CHART_HEIGHT = 460;

function QuadTooltip({ hover, containerWidth }: { hover: HoverState; containerWidth: number }) {
  const p = hover.point;
  // Flip to the left of the mark when close to the right edge so the tooltip stays on-canvas.
  const flip = hover.x > containerWidth * 0.62;
  const style: React.CSSProperties = {
    ...bbTooltipStyle,
    padding: "6px 8px",
    position: "absolute",
    top: Math.max(4, hover.y - 12),
    ...(flip ? { right: containerWidth - hover.x + 12 } : { left: hover.x + 12 }),
    pointerEvents: "none",
    whiteSpace: "nowrap",
    zIndex: 5,
  };
  return (
    <div style={style}>
      <div style={{ fontWeight: 700 }}>
        {p.ticker} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>{p.companyName ?? ""}</span>
      </div>
      <div style={{ color: "var(--text-muted)" }}>{p.sector} · {p.marketCapTier ?? "?"}</div>
      <div>breadth {p.breadth.toFixed(1)}% of funds · {p.fundsHolding} hold</div>
      <div>conviction {p.conviction === null ? "—" : `${p.conviction.toFixed(2)}% of book`}</div>
      <div>Δ holders {fmtDelta(p.deltaHolders)} · {p.quadrant ? QUADRANT_LABEL[p.quadrant] : ""}</div>
    </div>
  );
}

export function QuadrantPanel({ period, onSelectTicker }: { period: string | null; onSelectTicker: (t: string) => void }) {
  const { data, state, error } = useFlows<QuadrantPayload>(["flows-quadrant", period], `/api/analysis/flows/quadrant?minFunds=2${period ? `&period=${period}` : ""}`);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [containerRef, width] = useMeasure<HTMLDivElement>();

  const model = useMemo(() => (data ? buildQuadrantModel(data) : null), [data]);

  return (
    <PanelState state={state} error={error}>
      {data && model && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            x = breadth (% of tracked funds holding) · y = conviction (median % of fund book) ·{" "}
            {model.foreground.length} names in focus, {model.background.length} in the gray context layer.
            This view kills crowded late trades as visibly as it surfaces early ones.
          </div>
          <div
            ref={containerRef}
            style={{ position: "relative", width: "100%", height: CHART_HEIGHT, background: "var(--bg-surface)", border: "1px solid var(--bg-border)" }}
          >
            {width > 0 && (
              <QuadrantChart model={model} width={width} height={CHART_HEIGHT} onHover={setHover} onClickTicker={onSelectTicker} />
            )}
            {hover && <QuadTooltip hover={hover} containerWidth={width} />}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
            Upper-left = early conviction (edge lives here) · upper-right = crowded / late-trade risk. Click any bubble for its fund ledger.
            {" "}Highlighted names had a meaningful holder swing this quarter or are established top-decile-conviction positions; the rest render as context only.
            {" "}Breadth is discrete — each column is one more of the {model.trackedFunds} tracked funds (quant/index-like books excluded).
          </div>
        </div>
      )}
    </PanelState>
  );
}
