"use client";
/**
 * Danger-vector rail (Part 4b) — the tab's stated takeaways, rendered without
 * any hover: "moving into crowding fastest" (trail velocity toward the crowded
 * corner) and "elite leaving crowded names" (elite trim count × sizing).
 * Hovering a row highlights that name on the chart; clicking opens its ledger.
 */
import type { DangerRow } from "./takeaways";

function List({
  title,
  rows,
  empty,
  onHighlight,
  onOpenTicker,
}: {
  title: string;
  rows: DangerRow[];
  empty: string;
  onHighlight: (t: string | null) => void;
  onOpenTicker: (t: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "5px 8px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-secondary)", borderBottom: "1px solid var(--bg-border)" }}>
        {title}
      </div>
      {rows.length === 0 && <div style={{ padding: 8, fontSize: 10, color: "var(--text-muted)" }}>{empty}</div>}
      {rows.map((r) => (
        <div
          key={r.ticker}
          onMouseEnter={() => onHighlight(r.ticker)}
          onMouseLeave={() => onHighlight(null)}
          onClick={() => onOpenTicker(r.ticker)}
          title="Hover to highlight on the chart · click to open the ledger"
          style={{ padding: "4px 8px", borderBottom: "1px solid var(--bg-border)", cursor: "pointer" }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)" }}>{r.ticker}</div>
          <div style={{ fontSize: 9, color: "var(--text-muted)" }}>{r.stat}</div>
        </div>
      ))}
    </div>
  );
}

export function DangerRail({
  movingIn,
  eliteLeaving,
  width,
  onHighlight,
  onOpenTicker,
  onClose,
}: {
  movingIn: DangerRow[];
  eliteLeaving: DangerRow[];
  width: number;
  onHighlight: (t: string | null) => void;
  onOpenTicker: (t: string) => void;
  onClose: () => void;
}) {
  return (
    <div style={{ width, flex: `0 0 ${width}px`, background: "var(--bg-surface)", border: "1px solid var(--bg-border)", display: "flex", flexDirection: "column", overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 8px", borderBottom: "1px solid var(--bg-border)" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)" }}>Danger vectors</span>
        <button type="button" onClick={onClose} title="Hide" style={{ height: 18, padding: "0 6px", fontSize: 10, border: "1px solid var(--bg-border)", background: "var(--bg-base)", color: "var(--text-secondary)", cursor: "pointer", borderRadius: 0 }}>
          ✕
        </button>
      </div>
      <List title="Moving into crowding fastest" rows={movingIn} empty="No sustained moves toward the crowded corner." onHighlight={onHighlight} onOpenTicker={onOpenTicker} />
      <List title="Elite leaving crowded names" rows={eliteLeaving} empty="No elite trims in crowded names this quarter." onHighlight={onHighlight} onOpenTicker={onOpenTicker} />
    </div>
  );
}
