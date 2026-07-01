"use client";
/** 5.3 Accumulation-trajectory small multiples — durable staircase vs one-Q spike. */
import type { TrajectoryGridPayload } from "@/server/services/institutional/institutional-query.service";
import { useFlows } from "./useFlows";
import { AsOfLabelNote, CapTag, PanelState, Sparkline, trajectoryColor } from "./flowsUi";

const LABEL_TEXT: Record<string, string> = {
  durable: "durable build",
  accelerating: "accelerating",
  spike: "one-Q spike",
  choppy: "choppy",
};

export function TrajectoryGridPanel({ period, onSelectTicker }: { period: string | null; onSelectTicker: (t: string) => void }) {
  const { data, state, error } = useFlows<TrajectoryGridPayload>(["flows-trajectories", period], `/api/analysis/flows/trajectories?limit=18${period ? `&period=${period}` : ""}`);

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Holder count over the last 8 quarters. A rising staircase is durable accumulation (follow); a lone jump is a spike (discount). Top new-accumulation names shown.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
            {data.cards.map((c) => (
              <div
                key={c.ticker}
                onClick={() => onSelectTicker(c.ticker)}
                style={{ background: "var(--bg-surface)", border: "1px solid var(--bg-border)", padding: "8px 10px", cursor: "pointer" }}
                className="flows-row"
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontWeight: 700, color: "var(--color-info)", fontSize: 13 }}>{c.ticker}</span>
                    <CapTag tier={c.marketCapTier} />
                  </div>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>{c.latestHolders} funds</span>
                </div>
                <div style={{ margin: "6px 0 2px" }}>
                  <Sparkline values={c.series.map((s) => s.holders)} label={c.trajectoryLabel} width={200} height={44} />
                </div>
                <div style={{ fontSize: 10, color: trajectoryColor(c.trajectoryLabel), fontWeight: 700 }}>
                  {c.trajectoryLabel ? LABEL_TEXT[c.trajectoryLabel] ?? c.trajectoryLabel : "—"}
                </div>
              </div>
            ))}
          </div>
          <AsOfLabelNote />
        </div>
      )}
    </PanelState>
  );
}
