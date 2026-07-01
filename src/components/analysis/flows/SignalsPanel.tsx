"use client";
/** §6 First-mover / consensus-lag + Exit-cluster alert. */
import type { FirstMoverRow, ExitClusterRow } from "@/server/services/institutional/institutional-query.service";
import { useFlows } from "./useFlows";
import { CapTag, PanelState, quarterLabel } from "./flowsUi";

type FirstMoverPayload = { filingPeriod: string; rows: FirstMoverRow[] };
type ExitClusterPayload = { filingPeriod: string; rows: ExitClusterRow[] };

export function SignalsPanel({ period, onSelectTicker }: { period: string | null; onSelectTicker: (t: string) => void }) {
  const fm = useFlows<FirstMoverPayload>(["flows-firstmovers", period], `/api/analysis/flows/first-movers${period ? `?period=${period}` : ""}`);
  const ex = useFlows<ExitClusterPayload>(["flows-exits", period], `/api/analysis/flows/exit-clusters${period ? `?period=${period}` : ""}`);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          First-mover / consensus-lag
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
          Names where a most-respected fund established a position ≥2 quarters before broad accumulation began — the purest early-edge signal.
        </div>
        <PanelState state={fm.state} error={fm.error}>
          {fm.data && (fm.data.rows.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 10 }}>No lead-lag names this quarter.</div>
          ) : (
            <div style={{ border: "1px solid var(--bg-border)" }}>
              <RowHead cols={["Ticker", "Lead", "Respected entered → broad", "Now", "Early respected funds"]} grid="150px 60px 200px 60px 1fr" />
              {fm.data.rows.map((r) => (
                <div key={r.ticker} onClick={() => onSelectTicker(r.ticker)} className="flows-row" style={{ display: "grid", gridTemplateColumns: "150px 60px 200px 60px 1fr", gap: 8, padding: "7px 10px", alignItems: "center", borderBottom: "1px solid var(--bg-border)", cursor: "pointer", fontSize: 11 }}>
                  <Ticker t={r.ticker} tier={r.marketCapTier} sub={r.sector} />
                  <div style={{ fontWeight: 700, color: "var(--color-positive)" }}>{r.leadQuarters}Q</div>
                  <div style={{ color: "var(--text-secondary)" }}>{quarterLabel(r.respectedFirstPeriod)} → {quarterLabel(r.broadPeriod)}</div>
                  <div style={{ fontVariantNumeric: "tabular-nums" }}>{r.currentHolders}</div>
                  <div style={{ color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.earlyRespectedFunds.join(", ") || "—"}</div>
                </div>
              ))}
            </div>
          ))}
        </PanelState>
      </section>

      <section>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Exit-cluster alert
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
          Names where ≥3 high-conviction holders (≥1% of book, or most-respected) trimmed or exited simultaneously — a smart-money avoid signal.
        </div>
        <PanelState state={ex.state} error={ex.error}>
          {ex.data && (ex.data.rows.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 10 }}>No exit clusters this quarter.</div>
          ) : (
            <div style={{ border: "1px solid var(--bg-border)" }}>
              <RowHead cols={["Ticker", "Conviction exits", "Funds trimming / exiting"]} grid="150px 120px 1fr" />
              {ex.data.rows.map((r) => (
                <div key={r.ticker} onClick={() => onSelectTicker(r.ticker)} className="flows-row" style={{ display: "grid", gridTemplateColumns: "150px 120px 1fr", gap: 8, padding: "7px 10px", alignItems: "center", borderBottom: "1px solid var(--bg-border)", cursor: "pointer", fontSize: 11 }}>
                  <Ticker t={r.ticker} tier={r.marketCapTier} sub={r.sector} />
                  <div style={{ fontWeight: 700, color: "var(--color-negative)" }}>{r.convictionExits} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>/ {r.totalExits} total</span></div>
                  <div style={{ color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.funds.map((f) => `${f.name} (${f.action.toLowerCase()}${f.priorPctOfBook != null ? ` ${f.priorPctOfBook}%` : ""})`).join(" · ")}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </PanelState>
      </section>
    </div>
  );
}

function RowHead({ cols, grid }: { cols: string[]; grid: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: grid, gap: 8, padding: "6px 10px", fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", background: "var(--bg-surface)", borderBottom: "1px solid var(--bg-border)" }}>
      {cols.map((c, i) => <div key={i}>{c}</div>)}
    </div>
  );
}

function Ticker({ t, tier, sub }: { t: string; tier: string | null; sub: string | null }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontWeight: 700, color: "var(--color-info)", fontSize: 13 }}>{t}</span>
        <CapTag tier={tier} />
      </div>
      {sub ? <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{sub}</div> : null}
    </div>
  );
}
