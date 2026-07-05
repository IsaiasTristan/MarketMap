"use client";
/**
 * Trajectories — pipeline layout (Part 5).
 *
 * Scarcity is the headline: a stage census with QoQ deltas, then the durable
 * builds as full evidence cards (accumulation line + faint indexed price behind
 * it, evidence chips), forming builds as compact chips, spikes collapsed, and a
 * transitions panel. Ranked by pattern shape (streak × slope × breadth), never
 * the latest-quarter move. Base-rate lines on the DURABLE / FORMING headers.
 */
import { useState } from "react";
import type { DurableCard, TrajectoryPipelinePayload } from "@/server/services/institutional/institutional-query.service";
import { useFlows } from "./useFlows";
import { CapTag, FlagBadges, PanelState, fmtBps, fmtDelta } from "./flowsUi";
import { CoreHoldingsPanel } from "./CoreHoldingsPanel";

const STAGE_COLOR: Record<string, string> = {
  DURABLE: "var(--color-positive)",
  FORMING: "var(--color-info)",
  SPIKE: "var(--text-muted)",
  CORE: "var(--color-accent)",
  BROKEN: "var(--color-negative)",
};

export function TrajectoryPipelinePanel({ period, onSelectTicker }: { period: string | null; onSelectTicker: (t: string) => void }) {
  const { data, state, error } = useFlows<TrajectoryPipelinePayload>(["flows-pipeline", period], `/api/analysis/flows/pipeline${period ? `?period=${period}` : ""}`);
  const [spikesOpen, setSpikesOpen] = useState(false);

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Stage census header — scarcity up front. */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            {data.census.map((c) => (
              <div key={c.stage} style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "4px 10px", background: "var(--bg-surface)", border: "1px solid var(--bg-border)" }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: STAGE_COLOR[c.stage], fontVariantNumeric: "tabular-nums" }}>{c.count}</span>
                <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-secondary)" }}>{c.stage.toLowerCase()}</span>
                {c.deltaVsPrior !== 0 && (
                  <span style={{ fontSize: 10, color: c.deltaVsPrior > 0 ? "var(--color-positive)" : "var(--color-negative)" }}>{fmtDelta(c.deltaVsPrior)} vs last Q</span>
                )}
              </div>
            ))}
            <div style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>{data.transitionsCount} stage change{data.transitionsCount === 1 ? "" : "s"} this quarter</div>
          </div>

          {/* DURABLE — full evidence cards. */}
          <Section title="Durable builds" color={STAGE_COLOR.DURABLE!} baseRate={data.baseRates.durable} count={data.durable.length}>
            {data.durable.length === 0 ? (
              <Empty>No durable builds this quarter — scarcity is the signal.</Empty>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
                {data.durable.map((c) => <DurableCardView key={c.ticker} card={c} onClick={() => onSelectTicker(c.ticker)} />)}
              </div>
            )}
          </Section>

          {/* FORMING — compact chips. */}
          <Section title="Forming" color={STAGE_COLOR.FORMING!} baseRate={data.baseRates.forming} count={data.forming.length} subtitle="confirm next filing">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {data.forming.map((f) => (
                <div key={f.ticker} onClick={() => onSelectTicker(f.ticker)} className="flows-row" style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", background: "var(--bg-surface)", border: "1px solid var(--bg-border)", cursor: "pointer" }}>
                  <span style={{ fontWeight: 700, color: "var(--color-info)", fontSize: 12 }}>{f.ticker}</span>
                  <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>{Math.abs(f.streak)}q · {f.qualifier}</span>
                  {f.eliteCount > 0 && <span style={{ fontSize: 10, color: "var(--color-accent)" }}>★{f.eliteCount}</span>}
                  <FlagBadges flags={f.flags} />
                </div>
              ))}
              {data.forming.length === 0 && <Empty>None.</Empty>}
            </div>
          </Section>

          {/* SPIKES — collapsed. */}
          <div style={{ padding: "6px 10px", background: "var(--bg-surface)", border: "1px solid var(--bg-border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => setSpikesOpen((v) => !v)}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{spikesOpen ? "▾" : "▸"}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)" }}>{data.spikes.count} one-quarter spike{data.spikes.count === 1 ? "" : "s"}</span>
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>discount unless they persist — auto-promote to Forming next quarter if they hold</span>
            </div>
            {spikesOpen && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {data.spikes.items.map((s) => (
                  <div key={s.ticker} onClick={() => onSelectTicker(s.ticker)} className="flows-row" style={{ display: "flex", gap: 5, padding: "2px 7px", background: "var(--bg-base)", border: "1px solid var(--bg-border)", cursor: "pointer", fontSize: 11 }}>
                    <span style={{ color: "var(--text-secondary)", fontWeight: 700 }}>{s.ticker}</span>
                    <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{fmtBps(s.latestActiveBps)}</span>
                    <FlagBadges flags={s.flags} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* TRANSITIONS panel. */}
          {data.transitions.length > 0 && (
            <Section title="Transitions this quarter" color="var(--text-secondary)" count={data.transitions.length}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {data.transitions.map((t, i) => (
                  <div key={`${t.ticker}-${i}`} onClick={() => onSelectTicker(t.ticker)} className="flows-row" style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", background: "var(--bg-surface)", border: `1px solid ${t.significance >= 1 ? STAGE_COLOR[t.to ?? ""] ?? "var(--bg-border)" : "var(--bg-border)"}`, cursor: "pointer" }}>
                    <span style={{ fontWeight: 700, fontSize: 12, color: "var(--text-primary)" }}>{t.ticker}</span>
                    <span style={{ fontSize: 10, color: STAGE_COLOR[t.to ?? ""] ?? "var(--text-secondary)" }}>{t.from ?? "—"} → {t.to ?? "—"}</span>
                    {t.significance >= 1 && <span title="high-significance transition" style={{ fontSize: 10 }}>⚑</span>}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Core Holdings board (Part 6) — section below the pipeline. */}
          <div style={{ height: 1, background: "var(--bg-border)", margin: "4px 0" }} />
          <CoreHoldingsPanel period={period} onSelectTicker={onSelectTicker} />
        </div>
      )}
    </PanelState>
  );
}

function Section({ title, color, baseRate, count, subtitle, children }: { title: string; color: string; baseRate?: string | null; count?: number; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, borderBottom: `1px solid ${color}`, paddingBottom: 3 }}>
        <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color }}>{title}</span>
        {count != null && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{count}</span>}
        {subtitle && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>· {subtitle}</span>}
        {baseRate && <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-secondary)", fontStyle: "italic" }}>{baseRate}</span>}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "4px 0" }}>{children}</div>;
}

/** Dual-line chart: accumulation (solid blue) + faint dashed indexed price behind. */
function AccPriceChart({ acc, price, width = 280, height = 70 }: { acc: number[]; price: Array<number | null>; width?: number; height?: number }) {
  const pad = 4;
  const norm = (vals: number[]) => {
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    return (v: number) => height - pad - ((v - min) / span) * (height - 2 * pad);
  };
  const x = (i: number, n: number) => pad + (i / Math.max(1, n - 1)) * (width - 2 * pad);
  const accY = norm(acc);
  const accPts = acc.map((v, i) => `${x(i, acc.length).toFixed(1)},${accY(v).toFixed(1)}`).join(" ");
  const priceVals = price.filter((p): p is number => p != null);
  let pricePts = "";
  if (priceVals.length >= 2) {
    const pY = norm(priceVals);
    pricePts = price.map((v, i) => (v == null ? null : `${x(i, price.length).toFixed(1)},${pY(v).toFixed(1)}`)).filter(Boolean).join(" ");
  }
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {pricePts && <polyline points={pricePts} fill="none" stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="3 3" opacity={0.55} />}
      <polyline points={accPts} fill="none" stroke="var(--color-info)" strokeWidth={1.8} />
    </svg>
  );
}

function DurableCardView({ card, onClick }: { card: DurableCard; onClick: () => void }) {
  return (
    <div onClick={onClick} className="flows-row" style={{ background: "var(--bg-surface)", border: "1px solid var(--bg-border)", padding: "8px 10px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 700, color: "var(--color-positive)", fontSize: 14 }}>{card.ticker}</span>
          <CapTag tier={card.marketCapTier} />
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{Math.abs(card.streak)}q streak</span>
          <FlagBadges flags={card.flags} />
        </div>
        <span style={{ fontSize: 10, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>{card.holders} funds · {card.breadth.toFixed(1)}%</span>
      </div>
      <AccPriceChart acc={card.accSeries} price={card.priceIndexed} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {card.evidenceChips.map((chip, i) => (
          <span key={i} style={{ fontSize: 9.5, color: "var(--text-secondary)", background: "var(--bg-base)", border: "1px solid var(--bg-border)", padding: "1px 5px" }}>{chip}</span>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10, color: "var(--text-muted)" }}>
        <span>
          price since Q-end{" "}
          <span style={{ color: card.priceSincePeriodEnd == null ? "var(--text-muted)" : card.priceSincePeriodEnd >= 0 ? "var(--color-positive)" : "var(--color-negative)", fontWeight: 700 }}>
            {card.priceSincePeriodEnd == null ? "—" : `${card.priceSincePeriodEnd >= 0 ? "+" : ""}${card.priceSincePeriodEnd}%`}
          </span>
        </span>
        <span style={{ textTransform: "uppercase", letterSpacing: "0.05em", color: card.actionTag.includes("crowded") ? "var(--color-accent)" : "var(--color-positive)", fontWeight: 700 }}>{card.actionTag}</span>
      </div>
    </div>
  );
}
