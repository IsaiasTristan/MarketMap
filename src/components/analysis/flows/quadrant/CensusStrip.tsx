"use client";
/**
 * Zone census strip (Part 4a) — one chip per interpretation zone (count, QoQ
 * count delta, net flow), a regime-vector chip (net drift → crowding /
 * de-crowding / neutral), and a watchlist chip. Zone chips are click-filters
 * that dim the other zones on the chart.
 */
import { ZONE_LABEL, ZONE_ORDER, type Zone } from "./zones";
import type { ZoneCensus, RegimeVector, WatchlistCensus } from "./takeaways";
import { QUADRANT_CONFIG } from "./quadrantConfig";
import { fmtDelta } from "../flowsUi";

function qoq(n: number): string {
  return n === 0 ? "±0" : n > 0 ? `+${n}` : `${n}`;
}

export function CensusStrip({
  census,
  regime,
  watchlist,
  hasWatchlist,
  zoneFilter,
  onToggleZone,
}: {
  census: ZoneCensus[];
  regime: RegimeVector;
  watchlist: WatchlistCensus;
  hasWatchlist: boolean;
  zoneFilter: Zone | null;
  onToggleZone: (z: Zone) => void;
}) {
  const byZone = new Map(census.map((c) => [c.zone, c]));
  const regimeLabel = regime.direction === "crowding" ? "→ crowding" : regime.direction === "de-crowding" ? "→ de-crowding" : "neutral";
  const regimeColor = regime.direction === "crowding" ? "var(--color-neg, #e34948)" : regime.direction === "de-crowding" ? "var(--color-pos, #2a78d6)" : "var(--text-muted)";

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "stretch" }}>
      {ZONE_ORDER.map((z) => {
        const c = byZone.get(z)!;
        const active = zoneFilter === z;
        return (
          <button
            key={z}
            type="button"
            onClick={() => onToggleZone(z)}
            title={`Click to isolate the ${ZONE_LABEL[z]} zone`}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 1,
              minWidth: 96,
              padding: "3px 8px",
              textAlign: "left",
              border: `1px solid ${active ? "var(--color-accent)" : "var(--bg-border)"}`,
              background: active ? "var(--bg-elevated)" : "var(--bg-base)",
              color: "var(--text-secondary)",
              cursor: "pointer",
              borderRadius: 0,
            }}
          >
            <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-muted)" }}>{ZONE_LABEL[z]}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
              {c.count} <span style={{ fontSize: 9, fontWeight: 400, color: "var(--text-muted)" }}>({qoq(c.qoqDelta)} qoq)</span>
            </span>
            <span style={{ fontSize: 9, color: "var(--text-muted)" }}>net Δ {fmtDelta(c.netFlow)}</span>
          </button>
        );
      })}

      {/* Regime vector chip */}
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 110, padding: "3px 8px", border: "1px solid var(--bg-border)", background: "var(--bg-base)" }}>
        <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-muted)" }}>regime vector</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: regimeColor }}>{regimeLabel}</span>
        <span style={{ fontSize: 9, color: "var(--text-muted)" }}>mag {(regime.magnitude * 100).toFixed(1)}% (log)</span>
      </div>

      {/* Watchlist chip */}
      {hasWatchlist && (
        <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 110, padding: "3px 8px", border: `1px solid ${QUADRANT_CONFIG.colors.watchlistRing}`, background: "var(--bg-base)" }}>
          <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-muted)" }}>◍ watchlist</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>
            {watchlist.crowdedNow} <span style={{ fontSize: 9, fontWeight: 400, color: "var(--text-muted)" }}>in crowded ({qoq(watchlist.crowdedQoqDelta)} qoq)</span>
          </span>
        </div>
      )}
    </div>
  );
}
