"use client";
/** 5.1 Dashboard overview — change-detector tiles + top new accumulation. */
import type { OverviewPayload } from "@/server/services/institutional/institutional-query.service";
import { useFlows } from "./useFlows";
import { AsOfBanner, CapTag, PanelState, SplitBar, fmtDelta } from "./flowsUi";

function Tile({ label, value, sub, subTone }: { label: string; value: string; sub?: string; subTone?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 150, background: "var(--bg-surface)", border: "1px solid var(--bg-border)", padding: "10px 12px" }}>
      <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.2 }}>{value}</div>
      {sub ? <div style={{ fontSize: 10, color: subTone ?? "var(--text-muted)" }}>{sub}</div> : null}
    </div>
  );
}

export function OverviewPanel({ period, onSelectTicker }: { period: string | null; onSelectTicker: (t: string) => void }) {
  const { data, state, error } = useFlows<OverviewPayload>(["flows-overview", period], `/api/analysis/flows/overview${period ? `?period=${period}` : ""}`);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <PanelState state={state} error={error}>
        {data && (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Tile
                label="New accumulation"
                value={String(data.tiles.newAccumulation)}
                sub={`${fmtDelta(data.tiles.newAccumulationDelta)} vs last Q`}
                subTone={data.tiles.newAccumulationDelta >= 0 ? "var(--color-positive)" : "var(--color-negative)"}
              />
              <Tile
                label="New distribution"
                value={String(data.tiles.newDistribution)}
                sub={`${fmtDelta(data.tiles.newDistributionDelta)} vs last Q`}
                subTone={data.tiles.newDistributionDelta <= 0 ? "var(--color-positive)" : "var(--color-negative)"}
              />
              <Tile label="Crowding alerts" value={String(data.tiles.crowdingAlerts)} sub="late-trade risk" subTone="var(--color-accent)" />
              <Tile label="Small/mid-cap share" value={`${data.tiles.smallMidShare}%`} sub="of surfaced names" />
            </div>

            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 4 }}>
              Top new accumulation this quarter
              <span style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)", marginLeft: 8 }}>
                across {data.trackedFunds} tracked funds · click a ticker for the fund ledger
              </span>
            </div>

            <div style={{ border: "1px solid var(--bg-border)" }}>
              <div style={{ display: "grid", gridTemplateColumns: "150px 1fr 90px 80px", gap: 8, padding: "6px 10px", fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", background: "var(--bg-surface)", borderBottom: "1px solid var(--bg-border)" }}>
                <div>Ticker</div>
                <div>Funds buying vs selling</div>
                <div style={{ textAlign: "right" }}>% funds hold</div>
                <div style={{ textAlign: "right" }}>Δ holders</div>
              </div>
              {data.topNew.map((r) => (
                <div
                  key={r.ticker}
                  onClick={() => onSelectTicker(r.ticker)}
                  style={{ display: "grid", gridTemplateColumns: "150px 1fr 90px 80px", gap: 8, padding: "8px 10px", alignItems: "center", borderBottom: "1px solid var(--bg-border)", cursor: "pointer" }}
                  className="flows-row"
                >
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontWeight: 700, color: "var(--color-info)", fontSize: 13 }}>{r.ticker}</span>
                      <CapTag tier={r.marketCapTier} />
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 150 }}>
                      {r.companyName ?? ""}{r.sector ? ` · ${r.sector}` : ""}
                    </div>
                  </div>
                  <SplitBar bought={r.fundsBought} sold={r.fundsSold} width={280} />
                  <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#fff" }}>{r.pctOfFunds.toFixed(0)}%</div>
                  <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, color: r.deltaHolders >= 0 ? "var(--color-positive)" : "var(--color-negative)" }}>{fmtDelta(r.deltaHolders)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </PanelState>
    </div>
  );
}
