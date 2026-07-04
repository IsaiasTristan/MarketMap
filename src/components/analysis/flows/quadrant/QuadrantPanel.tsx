"use client";
/**
 * 5.2 Crowding-vs-conviction — the highest-value view. Raw axes; position is
 * the decision. Two render layers: a signal FOREGROUND (meaningful holder
 * swings or established above-median-conviction names) and a context
 * BACKGROUND (everything else, small and gray, never hit-tested).
 */
import { useEffect, useMemo, useState } from "react";
import type { QuadrantPayload } from "@/server/services/institutional/institutional-query.service";
import { useFlows } from "../useFlows";
import { PanelState, QUADRANT_LABEL, fmtDelta } from "../flowsUi";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import { buildQuadrantModel } from "./quadrantModel";
import { QuadrantChart, type HoverState } from "./QuadrantChart";
import { RegionInspector } from "./RegionInspector";
import { useMeasure } from "./useMeasure";
import { QUADRANT_CONFIG } from "./quadrantConfig";

const CHART_HEIGHT = 460;

/** Color = flow direction; marker area = |Δ holders|. */
function FlowLegend() {
  const c = QUADRANT_CONFIG.colors;
  const item = (color: string, label: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 9, height: 9, borderRadius: "50%", background: color, display: "inline-block" }} />
      <span>{label}</span>
    </span>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", fontSize: 10, color: "var(--text-secondary)" }}>
      {item(c.accumulating, "Accumulating")}
      {item(c.distributing, "Distributing")}
      {item(c.neutral, "No material change")}
      <span style={{ color: "var(--text-muted)" }}>marker size = |Δ holders|</span>
    </div>
  );
}

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
  // Alt-hover of a context (background) mark → a deliberately minimal tooltip.
  if (hover.minimal) {
    return (
      <div style={style}>
        <div style={{ fontWeight: 700 }}>
          {p.ticker} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>{p.companyName ?? ""}</span>
        </div>
        <div>breadth {p.breadth.toFixed(1)}% · conviction {p.conviction === null ? "—" : `${p.conviction.toFixed(2)}%`}</div>
        <div style={{ color: "var(--text-muted)" }}>no material change</div>
        {Math.abs(p.holderStreak) >= QUADRANT_CONFIG.streak.badgeMin && (
          <div style={{ color: "var(--text-muted)" }}>held {Math.abs(p.holderStreak)}+ quarters</div>
        )}
      </div>
    );
  }

  return (
    <div style={style}>
      <div style={{ fontWeight: 700 }}>
        {p.ticker} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>{p.companyName ?? ""}</span>
      </div>
      <div style={{ color: "var(--text-muted)" }}>{p.sector} · {p.marketCapTier ?? "?"}</div>
      <div>breadth {p.breadth.toFixed(1)}% of funds · {p.fundsHolding} hold</div>
      <div>conviction {p.conviction === null ? "—" : `${p.conviction.toFixed(2)}% of book`}</div>
      <div>Δ holders {fmtDelta(p.deltaHolders)} · {p.quadrant ? QUADRANT_LABEL[p.quadrant] : ""}</div>
      {Math.abs(p.holderStreak) >= QUADRANT_CONFIG.streak.badgeMin && (
        <div style={{ color: "var(--color-accent)" }}>
          streak: {Math.abs(p.holderStreak)} quarters {p.holderStreak > 0 ? "accumulating" : "distributing"}
        </div>
      )}
    </div>
  );
}

export function QuadrantPanel({ period, onSelectTicker }: { period: string | null; onSelectTicker: (t: string) => void }) {
  const { data, state, error } = useFlows<QuadrantPayload>(["flows-quadrant", period], `/api/analysis/flows/quadrant?minFunds=2${period ? `&period=${period}` : ""}`);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [pinned, setPinned] = useState<HoverState | null>(null);
  const [search, setSearch] = useState("");
  const [showTrails, setShowTrails] = useState(false);
  const [streakOnly, setStreakOnly] = useState(false);
  // Zone overlay defaults ON for first-time viewers; the choice persists.
  const [showZones, setShowZones] = useState(true);
  // Box-select region inspector (Part 2): the selection is a ticker set (rows
  // are re-derived from the model, so it survives zoom); `promoted` are names
  // pinned onto the chart from the inspector.
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [promoted, setPromoted] = useState<Set<string>>(() => new Set());
  const togglePromote = (t: string) =>
    setPromoted((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  // Esc clears the current selection (search box handles its own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelection(new Set()); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const saved = window.localStorage.getItem(QUADRANT_CONFIG.zones.storageKey);
    if (saved !== null) setShowZones(saved === "1");
  }, []);
  const toggleZones = () =>
    setShowZones((v) => {
      const next = !v;
      window.localStorage.setItem(QUADRANT_CONFIG.zones.storageKey, next ? "1" : "0");
      return next;
    });
  const [containerRef, width] = useMeasure<HTMLDivElement>();

  const model = useMemo(() => (data ? buildQuadrantModel(data, { streakOnly }) : null), [data, streakOnly]);

  // Hovering shows the hovered tooltip; otherwise the pinned search match (if any).
  const tip = hover ?? pinned;

  return (
    <PanelState state={state} error={error}>
      {data && model && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            x = breadth (% of tracked funds holding) · y = conviction (median % of fund book) ·{" "}
            {model.foreground.length} names in focus, {model.background.length} in the gray context layer.
            This view kills crowded late trades as visibly as it surfaces early ones.
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <FlowLegend />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                type="button"
                onClick={() => setStreakOnly((v) => !v)}
                title="Show only names on a ≥2-quarter same-direction streak"
                style={{ height: 22, padding: "0 8px", fontSize: 10, borderRadius: 0, cursor: "pointer", border: `1px solid ${streakOnly ? "var(--color-accent)" : "var(--bg-border)"}`, background: streakOnly ? "var(--color-accent)" : "var(--bg-base)", color: streakOnly ? "#000" : "var(--text-secondary)", fontWeight: streakOnly ? 700 : 400 }}
              >
                streak ≥ 2 only
              </button>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--text-secondary)", cursor: "pointer" }}>
                <input type="checkbox" checked={showZones} onChange={toggleZones} style={{ accentColor: "var(--color-accent)" }} />
                zones
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--text-secondary)", cursor: "pointer" }}>
                <input type="checkbox" checked={showTrails} onChange={(e) => setShowTrails(e.target.checked)} style={{ accentColor: "var(--color-accent)" }} />
                show trails
              </label>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
                placeholder="Find ticker or name…"
                aria-label="Highlight a name on the chart"
                style={{ height: 22, width: 180, padding: "0 8px", background: "var(--bg-elevated)", border: "1px solid var(--bg-border)", color: "var(--text-primary)", fontSize: 11, borderRadius: 0 }}
              />
              {search && (
                <button type="button" onClick={() => setSearch("")} title="Clear (Esc)" style={{ height: 22, padding: "0 8px", border: "1px solid var(--bg-border)", background: "var(--bg-base)", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer", borderRadius: 0 }}>
                  ✕
                </button>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "stretch", height: CHART_HEIGHT }}>
            <div
              ref={containerRef}
              style={{ position: "relative", flex: 1, minWidth: 0, height: CHART_HEIGHT, background: "var(--bg-surface)", border: "1px solid var(--bg-border)" }}
            >
              {width > 0 && (
                <QuadrantChart
                  model={model}
                  width={width}
                  height={CHART_HEIGHT}
                  search={search}
                  showTrails={showTrails}
                  showZones={showZones}
                  promoted={promoted}
                  onHover={setHover}
                  onPinnedChange={setPinned}
                  onClickTicker={onSelectTicker}
                  onSelectRegion={(tickers) => setSelection(new Set(tickers))}
                />
              )}
              {tip && <QuadTooltip hover={tip} containerWidth={width} />}
            </div>
            {selection.size > 0 && (
              <RegionInspector
                tickers={selection}
                model={model}
                gutterFloorPct={QUADRANT_CONFIG.gutter.floorBps / 100}
                promoted={promoted}
                onTogglePromote={togglePromote}
                onSelectTicker={onSelectTicker}
                onClear={() => setSelection(new Set())}
              />
            )}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
            Upper-left = early conviction (edge lives here) · upper-right = crowded / late-trade risk. Click any highlighted name (cursor turns to a pointer) to open its fund ledger; gray context marks aren&apos;t clickable.
            {" "}Highlighted names had a meaningful holder swing this quarter or are established top-decile-conviction positions; the rest render as context only.
            {" "}Hover a name (or toggle <em>show trails</em>) to trace its move from last quarter — travel into the crowded upper-right is the risk signal.
            {" "}Breadth is discrete — each column is one more of the {model.trackedFunds} tracked funds (quant/index-like books excluded); low-holder columns are nudged apart slightly for legibility.
            {" "}<span style={{ color: "var(--text-secondary)" }}>Hold <kbd style={{ fontFamily: "inherit", fontWeight: 700 }}>Alt</kbd> to inspect context marks · drag empty space to select a region (<kbd style={{ fontFamily: "inherit", fontWeight: 700 }}>Esc</kbd> clears).</span>
          </div>
        </div>
      )}
    </PanelState>
  );
}
