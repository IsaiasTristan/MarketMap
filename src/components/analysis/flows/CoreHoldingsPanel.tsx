"use client";
/**
 * Core Holdings board (Part 6) — long-held, high-conviction, zero-flow names
 * that every other Flows view gates out. Ranked by fund-relative endorsement.
 *
 * Row: rank, ticker+name, 12-quarter weight-stability strip (final bar red +
 * bell WITH TEXT on an active stasis break — never color alone), holders,
 * median wt, avg tenure (≥ where censored), elite count, endorsement bar
 * (tooltip = score decomposition). Alert strip above; stasis-break base rate.
 */
import type { CoreHoldingRow, CoreHoldingsPayload } from "@/server/services/institutional/institutional-query.service";
import { useFlows } from "./useFlows";
import { PanelState } from "./flowsUi";

export function CoreHoldingsPanel({ period, onSelectTicker }: { period: string | null; onSelectTicker: (t: string) => void }) {
  const { data, state, error } = useFlows<CoreHoldingsPayload>(["flows-core-holdings", period], `/api/analysis/flows/core-holdings${period ? `?period=${period}` : ""}`);

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, borderBottom: "1px solid var(--color-accent)", paddingBottom: 3 }}>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-accent)" }}>Core Holdings</span>
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>fund-relative long-hold endorsement — the durable, high-conviction names that carry no flow signal</span>
            {data.stasisBaseRate && <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-secondary)", fontStyle: "italic" }}>{data.stasisBaseRate}</span>}
          </div>

          {/* Stasis-break alert strip. */}
          {data.alerts.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "5px 8px", background: "rgba(255,50,50,0.08)", border: "1px solid var(--color-negative)" }}>
              <span style={{ fontSize: 11 }}>🔔</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--color-negative)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Stasis breaks</span>
              {data.alerts.map((a) => (
                <span key={a.ticker} onClick={() => onSelectTicker(a.ticker)} title={[`${a.departed} of ${a.priorLongHolders} long-hold voters cut/exited this quarter${a.severity != null ? ` — ${a.severity.toFixed(1)}σ vs this name's baseline` : ""}`, ...a.departing.map((d) => `  ${d.fund} (${d.tenureMult}× tenure, ${d.action})`)].join("\n")} className="flows-row" style={{ fontSize: 10, color: "var(--text-secondary)", cursor: "pointer", border: "1px solid var(--bg-border)", padding: "1px 5px", background: "var(--bg-base)" }}>
                  <b style={{ color: "var(--text-primary)" }}>{a.ticker}</b> {a.departed}/{a.priorLongHolders} cut{a.severity != null ? ` · ${a.severity.toFixed(1)}σ` : ""}{a.partialData ? " ⚑" : ""}
                </span>
              ))}
            </div>
          )}

          {data.rows.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 8 }}>No valid core holdings this quarter (needs ≥5 long-hold voters across ≥2 fund categories).</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <Header />
              {data.rows.map((r) => <Row key={r.ticker} row={r} maxScore={data.rows[0]!.endorsementScore || 1} onClick={() => onSelectTicker(r.ticker)} />)}
            </div>
          )}
        </div>
      )}
    </PanelState>
  );
}

const COLS = "28px 150px 150px 44px 60px 70px 48px 1fr";

function Header() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 8, alignItems: "center", padding: "2px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", borderBottom: "1px solid var(--bg-border)" }}>
      <span>#</span>
      <span>Name</span>
      <span>12q weight stability</span>
      <span style={{ textAlign: "right" }}>Hold</span>
      <span style={{ textAlign: "right" }}>Med wt</span>
      <span style={{ textAlign: "right" }}>Avg ten</span>
      <span style={{ textAlign: "right" }}>Elite</span>
      <span>Endorsement</span>
    </div>
  );
}

function Row({ row, maxScore, onClick }: { row: CoreHoldingRow; maxScore: number; onClick: () => void }) {
  const barPct = Math.max(2, Math.round((row.endorsementScore / maxScore) * 100));
  const tenureLabel = `${row.censoredPct > 0 ? "≥" : ""}${row.avgTenure ?? "—"}`;
  const tip = row.contributions
    .slice(0, 12)
    .map((c) => `${c.fund}${c.isElite ? " ★" : ""}: ${c.tenureMult}× × ${Math.round(c.weightBps)}bps → ${c.contribution.toFixed(0)}`)
    .join("\n");
  return (
    <div onClick={onClick} className="flows-row" style={{ display: "grid", gridTemplateColumns: COLS, gap: 8, alignItems: "center", padding: "3px 6px", cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--bg-border)" }}>
      <span style={{ fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{row.rank}</span>
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 12, color: "var(--text-primary)" }}>
          {row.ticker}
          {row.verifyData && <span title="a long-hold voter's fund had a >50% book reset this quarter (possible entity/CIK change) — verify tenure" style={{ fontSize: 8, color: "var(--color-accent)", marginLeft: 4 }}>⚠ verify</span>}
        </span>
        <span style={{ fontSize: 9, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.companyName ?? ""}</span>
      </div>
      <WeightStrip row={row} />
      <span style={{ textAlign: "right", fontSize: 11, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>{row.longHoldVoters}</span>
      <span style={{ textAlign: "right", fontSize: 11, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>{row.weightStrip.at(-1)?.medianPct != null ? `${row.weightStrip.at(-1)!.medianPct!.toFixed(1)}%` : "—"}</span>
      <span style={{ textAlign: "right", fontSize: 11, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }} title={row.censoredPct > 0 ? `${Math.round(row.censoredPct * 100)}% of voter tenures left-censored (held since before the tracked history)` : undefined}>{tenureLabel}</span>
      <span style={{ textAlign: "right", fontSize: 11, color: row.eliteVoters > 0 ? "var(--color-accent)" : "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{row.eliteVoters > 0 ? `★${row.eliteVoters}` : "—"}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }} title={tip}>
        <div style={{ flex: 1, height: 12, background: "var(--bg-base)", border: "1px solid var(--bg-border)", position: "relative", maxWidth: 220 }}>
          <div style={{ position: "absolute", inset: 0, width: `${barPct}%`, background: "var(--color-accent)", opacity: 0.85 }} />
        </div>
        <span style={{ fontSize: 10, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums", minWidth: 44, textAlign: "right" }}>{Math.round(row.endorsementScore).toLocaleString()}</span>
        {row.stasisBreak && <span title={`stasis break — ${row.stasisBreak.departed} of ${row.stasisBreak.priorLongHolders} long-hold voters trimmed/exited this quarter${row.stasisBreak.severity != null ? ` (${row.stasisBreak.severity.toFixed(1)}σ vs this name's own baseline)` : ""}${row.stasisBreak.partialData ? " — partial data: some voters' funds have not filed" : ""}`} style={{ fontSize: 10, color: "var(--color-negative)" }}>🔔 break{row.stasisBreak.partialData ? " ⚑" : ""}</span>}
      </div>
    </div>
  );
}

/** 12-quarter weight-stability strip; final bar turns red on an active stasis break. */
function WeightStrip({ row }: { row: CoreHoldingRow }) {
  const vals = row.weightStrip.map((w) => w.medianPct ?? 0);
  const max = Math.max(1, ...vals);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 22 }}>
      {row.weightStrip.map((w, i) => {
        const isLast = i === row.weightStrip.length - 1;
        const h = w.medianPct != null ? Math.max(2, (w.medianPct / max) * 22) : 0;
        const broke = isLast && row.stasisBreak != null;
        return (
          <div
            key={w.period}
            title={`${w.period}: ${w.medianPct != null ? `${w.medianPct.toFixed(1)}% median wt` : "not held"} · ${w.holders} funds`}
            style={{ width: 8, height: h, background: broke ? "var(--color-negative)" : w.medianPct != null ? "var(--color-accent)" : "transparent", opacity: broke ? 1 : 0.6, border: w.medianPct == null ? "1px dashed var(--bg-border)" : "none" }}
          />
        );
      })}
    </div>
  );
}
