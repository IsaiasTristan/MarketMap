"use client";
/**
 * Flow Leaderboard — ranked accumulation heatmap. The ROW ORDER IS THE RANKING:
 * the top row is the strongest multi-quarter accumulation story. Sorting is fixed
 * by score (no user re-sort — the ranking is the product). A search box
 * highlights/scrolls to any ticker, including gated-out names ("below threshold").
 */
import { useMemo, useRef, useState } from "react";
import type { GatedOutRow, HeatCell, Leaderboard, ScoredRow } from "@/domain/calculations/flow-leaderboard";
import { pickTextColor } from "@/components/analysis/factors/shared/bloomberg-grid";
import { useFlows } from "../useFlows";
import { PanelState, quarterLabel } from "../flowsUi";
import { flowHeatColor, FLOW_BLUE, FLOW_RED } from "./flowHeat";

type LeaderboardResult = Leaderboard & { filingPeriod: string; ingredientsVersion: number };

const HEAT_SPAN = 25; // diverging fill saturates at |25| net funds (per spec)
const fmt = (n: number | null, d = 1): string => (n == null ? "—" : n.toFixed(d));

export function LeaderboardPanel({ period, onSelectTicker }: { period: string | null; onSelectTicker: (t: string) => void }) {
  const { data, state, error } = useFlows<LeaderboardResult>(
    ["flows-leaderboard", period],
    `/api/analysis/flows/leaderboard${period ? `?period=${period}` : ""}`,
    period != null,
  );
  const [query, setQuery] = useState("");
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const q = query.trim().toUpperCase();

  const gatedMatch = useMemo(() => {
    if (!data || !q) return null;
    const onBoards = new Set([...data.accumulation, ...data.distribution].map((r) => r.ticker));
    if (onBoards.has(q)) return null;
    return data.gatedOut.find((g) => g.ticker === q) ?? null;
  }, [data, q]);

  function scrollTo(ticker: string) {
    const el = rowRefs.current.get(ticker);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Search + legend */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ position: "relative" }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery("");
                  if (e.key === "Enter" && q) scrollTo(q);
                }}
                placeholder="Find ticker…"
                style={{ height: 24, width: 180, padding: "0 24px 0 8px", background: "var(--bg-elevated)", border: "1px solid var(--bg-border)", color: "var(--text-primary)", fontSize: 11, borderRadius: 0 }}
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} title="Clear" style={{ position: "absolute", right: 4, top: 3, width: 18, height: 18, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>✕</button>
              )}
            </div>
            <Legend />
          </div>

          {gatedMatch && <BelowThreshold row={gatedMatch} />}

          <Board
            title="Accumulation leaders"
            accent={FLOW_BLUE}
            rows={data.accumulation}
            highlight={q}
            rowRefs={rowRefs}
            onSelectTicker={onSelectTicker}
          />
          <Board
            title="Distribution watch"
            accent={FLOW_RED}
            rows={data.distribution}
            highlight={q}
            rowRefs={rowRefs}
            onSelectTicker={onSelectTicker}
          />

          <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {quarterLabel(data.filingPeriod)} · ranking = recency-weighted count flow + capital flow (bps), z-scored across
            gated names, ×streak ×conviction ×elite. Signal-tier funds only. Fixed sort by score — click a row for the fund
            ledger.
          </div>
        </div>
      )}
    </PanelState>
  );
}

function Legend() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "var(--text-muted)" }}>
      <span>distribution</span>
      <span style={{ width: 14, height: 12, background: FLOW_RED }} />
      <span style={{ width: 14, height: 12, background: flowHeatColor(0) }} />
      <span style={{ width: 14, height: 12, background: FLOW_BLUE }} />
      <span>accumulation</span>
      <span style={{ marginLeft: 6 }}>· cell = net adders−reducers</span>
    </div>
  );
}

const COLS = "28px minmax(220px, 1fr) repeat(5, 46px) 120px 52px 60px";

function Board({
  title,
  accent,
  rows,
  highlight,
  rowRefs,
  onSelectTicker,
}: {
  title: string;
  accent: string;
  rows: ScoredRow[];
  highlight: string;
  rowRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  onSelectTicker: (t: string) => void;
}) {
  return (
    <div style={{ border: "1px solid var(--bg-border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 24, padding: "0 8px", background: "var(--bb-chrome)", color: "#fff", borderLeft: `3px solid ${accent}` }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>{title}</span>
        <span style={{ fontSize: 9, opacity: 0.8 }}>{rows.length} names</span>
      </div>
      {/* Header */}
      <div style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", height: 20, padding: "0 8px", background: "var(--bg-surface)", fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        <span>#</span>
        <span>Ticker · why it&apos;s here</span>
        <span style={{ gridColumn: "3 / 8", textAlign: "center" }}>trailing 5 quarters (net funds)</span>
        <span style={{ textAlign: "right" }}>score</span>
        <span style={{ textAlign: "right" }}>hold</span>
        <span style={{ textAlign: "right" }}>med wt</span>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: 12, fontSize: 11, color: "var(--text-muted)" }}>No qualifying names this quarter.</div>
      ) : (
        rows.map((r) => (
          <Row key={r.ticker} r={r} accent={accent} highlighted={highlight === r.ticker} rowRefs={rowRefs} onSelectTicker={onSelectTicker} />
        ))
      )}
    </div>
  );
}

function Row({
  r,
  accent,
  highlighted,
  rowRefs,
  onSelectTicker,
}: {
  r: ScoredRow;
  accent: string;
  highlighted: boolean;
  rowRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  onSelectTicker: (t: string) => void;
}) {
  return (
    <div
      ref={(el) => {
        rowRefs.current.set(r.ticker, el);
      }}
      onClick={() => onSelectTicker(r.ticker)}
      style={{
        display: "grid",
        gridTemplateColumns: COLS,
        alignItems: "center",
        minHeight: 34,
        padding: "2px 8px",
        borderTop: "1px solid var(--bg-border)",
        cursor: "pointer",
        background: highlighted ? "var(--bg-elevated)" : "transparent",
        outline: highlighted ? `1px solid ${accent}` : "none",
      }}
      className="flows-row"
      title="Click for the fund ledger"
    >
      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{r.rank}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>{r.ticker}</span>
          {Math.abs(r.streak) >= 2 && (
            <span title={`${Math.abs(r.streak)}-quarter same-direction streak`} style={{ fontSize: 9, fontWeight: 700, padding: "0 4px", height: 14, lineHeight: "14px", color: accent, border: `1px solid ${accent}` }}>
              {r.streak > 0 ? "▲" : "▼"}{Math.abs(r.streak)}
            </span>
          )}
          {r.partialData && (
            <span title="Some holders' filings are missing this quarter — score may be incomplete" style={{ fontSize: 8, fontWeight: 700, padding: "0 3px", height: 14, lineHeight: "14px", color: "var(--color-accent)", border: "1px solid var(--color-accent)" }}>PARTIAL</span>
          )}
          {r.companyName && <span style={{ fontSize: 9, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.companyName}</span>}
        </div>
        <div style={{ fontSize: 9, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.reason}</div>
      </div>
      {padCells(r.cells).map((c, i) => (
        <HeatCellView key={i} cell={c} />
      ))}
      <ScoreBar score={r.score} accent={accent} />
      <span style={{ textAlign: "right", fontSize: 11, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{r.holders}</span>
      <span style={{ textAlign: "right", fontSize: 11, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>{fmt(r.medianWeight)}%</span>
    </div>
  );
}

/** Left-pad the heat strip to 5 cells if a name has less history. */
function padCells(cells: HeatCell[]): Array<HeatCell | null> {
  const out: Array<HeatCell | null> = [...cells].slice(-5);
  while (out.length < 5) out.unshift(null);
  return out;
}

function HeatCellView({ cell }: { cell: HeatCell | null }) {
  // Rendering contract: null / no coverage → em-dash (muted). A present cell whose
  // netflow is not a finite number is treated as no-coverage too — never default a
  // missing field to a computed "0". Only a real computed zero renders "0".
  if (!cell || !Number.isFinite(cell.netflow)) {
    return (
      <span
        title="no filing coverage"
        style={{ height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-base)", border: "1px solid var(--bg-border)", color: "var(--text-muted)", fontSize: 11 }}
      >
        —
      </span>
    );
  }
  const bg = flowHeatColor(cell.netflow, HEAT_SPAN);
  const color = pickTextColor(bg);
  const bps = Math.round(cell.netflowBps);
  const title = `${quarterLabel(cell.period)} · ${cell.period}\n+${cell.adders} adders / −${cell.reducers} reducers (net ${cell.netflow >= 0 ? "+" : ""}${cell.netflow})\ncapital flow ${bps >= 0 ? "+" : ""}${bps} bps · ${cell.holders} holders`;
  return (
    <span title={title} style={{ height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: bg, color, fontSize: 11, fontWeight: 700, fontVariantNumeric: "tabular-nums", border: "1px solid var(--bg-base)" }}>
      {cell.netflow > 0 ? "+" : ""}{cell.netflow}
    </span>
  );
}

function ScoreBar({ score, accent }: { score: number; accent: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
      <div style={{ width: 60, height: 10, background: "var(--bg-base)", border: "1px solid var(--bg-border)" }}>
        <div style={{ width: `${Math.max(2, score)}%`, height: "100%", background: accent }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums", minWidth: 24, textAlign: "right" }}>{Math.round(score)}</span>
    </div>
  );
}

function BelowThreshold({ row }: { row: GatedOutRow }) {
  return (
    <div style={{ padding: "6px 10px", background: "var(--bg-elevated)", border: "1px dashed var(--bg-border)", fontSize: 11, color: "var(--text-secondary)" }}>
      <b style={{ color: "var(--text-primary)" }}>{row.ticker}</b>
      {row.companyName ? ` · ${row.companyName}` : ""} — below threshold: {row.reason}.{" "}
      <span style={{ color: "var(--text-muted)" }}>
        (holders {row.holders}, wflow {row.wflow.toFixed(1)}, wflow_bps {row.wflowBps.toFixed(1)})
      </span>
    </div>
  );
}
