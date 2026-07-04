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
  watchlistTotal,
  watchlistActive,
  onToggleWatchlist,
  zoneFilter,
  onToggleZone,
}: {
  census: ZoneCensus[];
  regime: RegimeVector;
  watchlist: WatchlistCensus;
  /** Total watchlist names on the chart (headline count); 0 disables the chip. */
  watchlistTotal: number;
  /** Whether watchlist isolation is currently active. */
  watchlistActive: boolean;
  onToggleWatchlist: () => void;
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
        const empty = c.count === 0;
        return (
          <button
            key={z}
            type="button"
            disabled={empty}
            onClick={() => { if (!empty) onToggleZone(z); }}
            title={empty ? `No names in the ${ZONE_LABEL[z]} zone this quarter` : `Click to isolate the ${ZONE_LABEL[z]} zone`}
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
              cursor: empty ? "default" : "pointer",
              opacity: empty ? 0.45 : 1,
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

      {/* Watchlist chip — clickable isolation filter (like the zone chips). */}
      {watchlistTotal > 0 && (
        <button
          type="button"
          onClick={onToggleWatchlist}
          title="Click to isolate your watchlist names"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            minWidth: 110,
            padding: "3px 8px",
            textAlign: "left",
            border: `1px solid ${watchlistActive ? "var(--color-accent)" : QUADRANT_CONFIG.colors.watchlistRing}`,
            background: watchlistActive ? "var(--bg-elevated)" : "var(--bg-base)",
            color: "var(--text-secondary)",
            cursor: "pointer",
            borderRadius: 0,
          }}
        >
          <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-muted)" }}>◍ watchlist</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
            {watchlistTotal} <span style={{ fontSize: 9, fontWeight: 400, color: "var(--text-muted)" }}>· {watchlist.crowdedNow} in crowded ({qoq(watchlist.crowdedQoqDelta)} qoq)</span>
          </span>
        </button>
      )}
    </div>
  );
}
