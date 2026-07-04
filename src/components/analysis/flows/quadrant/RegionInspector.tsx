"use client";
/**
 * Box-select region inspector (Part 2) — a dismissible right rail listing every
 * name inside the selection rectangle (foreground + context + gutter), sorted by
 * conviction. Rows re-derive from the model each render, so the selection
 * survives zoom/pan. Click a row to promote (pin a label on the chart); the
 * ledger button opens the fund ledger.
 */
import { useMemo } from "react";
import { deriveInspectorRows, aggregateNetFlow, type InspectorRow } from "./inspectorRows";
import type { QuadrantModel } from "./quadrantModel";
import { QUADRANT_CONFIG } from "./quadrantConfig";
import { ZONE_LABEL } from "./zones";
import { fmtDelta } from "../flowsUi";

const cellNum = (n: number | null, digits = 2) => (n === null ? "—" : n.toFixed(digits));

function toCsv(rows: InspectorRow[]): string {
  const headers = ["ticker", "company", "breadth_pct", "conviction_pct", "delta_holders", "zone", "layer", "streak", "trajectory"];
  const esc = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([r.ticker, r.companyName, r.breadth, r.conviction, r.deltaHolders, ZONE_LABEL[r.zone], r.layer, r.holderStreak, r.trajectoryLabel].map(esc).join(","));
  }
  return lines.join("\n");
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function RegionInspector({
  tickers,
  model,
  gutterFloorPct,
  promoted,
  onTogglePromote,
  onSelectTicker,
  onClear,
}: {
  tickers: Set<string>;
  model: QuadrantModel;
  gutterFloorPct: number;
  promoted: Set<string>;
  onTogglePromote: (ticker: string) => void;
  onSelectTicker: (ticker: string) => void;
  onClear: () => void;
}) {
  const rows = useMemo(() => deriveInspectorRows(tickers, model, gutterFloorPct), [tickers, model, gutterFloorPct]);

  const { zonesCovered, netFlow, staticHighConv } = useMemo(() => {
    const zones = new Set(rows.map((r) => r.zone));
    const minAbsDelta = QUADRANT_CONFIG.foreground.minAbsDelta;
    // A distinct idea class: high-conviction names sitting quietly (small Δ) in
    // the emerging zone — "conviction before the crowd".
    const staticHighConv = rows.filter((r) => r.zone === "emerging" && Math.abs(r.deltaHolders) < minAbsDelta).length;
    return { zonesCovered: [...zones], netFlow: aggregateNetFlow(rows), staticHighConv };
  }, [rows]);

  const headStyle: React.CSSProperties = { fontSize: 10, color: "var(--text-muted)" };

  return (
    <div
      style={{
        width: QUADRANT_CONFIG.inspector.width,
        flex: `0 0 ${QUADRANT_CONFIG.inspector.width}px`,
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        display: "flex",
        flexDirection: "column",
        maxHeight: "100%",
      }}
    >
      {/* Header */}
      <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--bg-border)", display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)" }}>{rows.length} selected</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={() => downloadCsv("quadrant-selection.csv", toCsv(rows))}
              disabled={rows.length === 0}
              title="Export selection to CSV"
              style={{ height: 20, padding: "0 6px", fontSize: 10, border: "1px solid var(--bg-border)", background: "var(--bg-base)", color: "var(--text-secondary)", cursor: rows.length ? "pointer" : "default", borderRadius: 0 }}
            >
              ↓ CSV
            </button>
            <button
              type="button"
              onClick={onClear}
              title="Clear selection (Esc)"
              style={{ height: 20, padding: "0 6px", fontSize: 10, border: "1px solid var(--bg-border)", background: "var(--bg-base)", color: "var(--text-secondary)", cursor: "pointer", borderRadius: 0 }}
            >
              ✕
            </button>
          </div>
        </div>
        <div style={headStyle}>
          net Δ {fmtDelta(netFlow)} · {zonesCovered.length ? zonesCovered.map((z) => ZONE_LABEL[z]).join(", ") : "—"}
        </div>
        {staticHighConv > 0 && (
          <div style={{ fontSize: 10, color: "var(--color-accent)" }}>static high-conviction: {staticHighConv}</div>
        )}
      </div>

      {/* Rows */}
      <div style={{ overflowY: "auto", flex: 1 }}>
        {rows.map((r) => {
          const isPromoted = promoted.has(r.ticker);
          return (
            <div
              key={r.ticker}
              onClick={() => onTogglePromote(r.ticker)}
              onDoubleClick={() => onSelectTicker(r.ticker)}
              title="Click to pin a label on the chart · double-click to open the ledger"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 2,
                padding: "4px 8px",
                borderBottom: "1px solid var(--bg-border)",
                cursor: "pointer",
                background: isPromoted ? "var(--bg-elevated)" : "transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)" }}>{r.ticker}</span>
                {isPromoted && <span title="pinned on chart" style={{ fontSize: 9, color: "var(--color-accent)" }}>📌</span>}
                {r.danger && <span title="crowded — distribution" style={{ fontSize: 9, color: "var(--color-neg, #e34948)" }}>▲</span>}
                {r.layer === "below range" && <span style={headStyle}>· below range</span>}
                {r.trajectoryLabel && <span style={{ fontSize: 9, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.trajectoryLabel}</span>}
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onSelectTicker(r.ticker); }}
                title="Open fund ledger"
                style={{ fontSize: 9, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", padding: 0 }}
              >
                ledger →
              </button>
              <div style={{ gridColumn: "1 / -1", fontSize: 10, color: "var(--text-secondary)", display: "flex", gap: 10 }}>
                <span>breadth {cellNum(r.breadth, 1)}%</span>
                <span>conv {cellNum(r.conviction)}%</span>
                <span>Δ {fmtDelta(r.deltaHolders)}</span>
              </div>
            </div>
          );
        })}
        {rows.length === 0 && <div style={{ padding: 8, fontSize: 10, color: "var(--text-muted)" }}>Nothing in the selection.</div>}
      </div>
    </div>
  );
}
