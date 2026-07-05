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
import type { DurableCard, SpikesPayload, TrajectoryPipelinePayload } from "@/server/services/institutional/institutional-query.service";
import { useFlows } from "./useFlows";
import { CapTag, FlagBadges, PanelState } from "./flowsUi";
import { CoreHoldingsPanel } from "./CoreHoldingsPanel";
import { PipelineFunnel, FormingRunway, TransitionsView, type FunnelSeg } from "./TrajectoryVisuals";

const STAGE_COLOR: Record<string, string> = {
  DURABLE: "var(--color-positive)",
  FORMING: "var(--color-info)",
  SPIKE: "var(--text-muted)",
  WATCH: "var(--text-muted)",
  CORE: "var(--color-accent)",
  BROKEN: "var(--color-negative)",
};

export function TrajectoryPipelinePanel({ period, onSelectTicker }: { period: string | null; onSelectTicker: (t: string) => void }) {
  const [includeMega, setIncludeMega] = useState(false);
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const cap = includeMega ? "all" : "ex-mega";
  const qs = new URLSearchParams();
  if (period) qs.set("period", period);
  qs.set("cap", cap);
  const { data, state, error } = useFlows<TrajectoryPipelinePayload>(["flows-pipeline", period, cap], `/api/analysis/flows/pipeline?${qs.toString()}`);
  const show = (s: string) => stageFilter == null || stageFilter === s;

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* PIPELINE FUNNEL (6a) — proportional segments, QoQ deltas, click-to-filter. */}
          {(() => {
            const cm = new Map(data.census.map((c) => [c.stage, c]));
            const segFor = (stage: string, label = stage, count?: number, delta?: number, fallingIsGood?: boolean): FunnelSeg => ({
              stage: label,
              count: count ?? cm.get(stage)?.count ?? 0,
              delta: delta ?? cm.get(stage)?.deltaVsPrior ?? 0,
              fallingIsGood,
            });
            const segs: FunnelSeg[] = [
              segFor("SPIKE"),
              segFor("FORMING"),
              segFor("DURABLE"),
              segFor("CORE", "CORE", data.coreCount, data.coreDeltaVsPrior),
              segFor("BROKEN", "STREAK ENDED", undefined, undefined, true),
            ];
            return (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.05em", color: "var(--text-primary)" }}>PIPELINE</span>
                  <label style={{ fontSize: 10, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }} title="Mega-caps are excluded from durable cards by default; toggle to include them (dimmed, informational only).">
                    <input type="checkbox" checked={includeMega} onChange={(e) => setIncludeMega(e.target.checked)} style={{ cursor: "pointer" }} />
                    include mega
                  </label>
                </div>
                <PipelineFunnel segs={segs} active={stageFilter} onToggle={(s) => setStageFilter((cur) => (cur === s ? null : s))} />
              </div>
            );
          })()}

          {/* DURABLE — full evidence cards (2a floor, 2c ex-mega). */}
          {show("DURABLE") && (
            <Section title="Durable builds" color={STAGE_COLOR.DURABLE!} baseRate={data.baseRates.durable} count={data.durable.length}>
              {data.durable.length === 0 ? (
                <Empty>No durable builds this quarter — scarcity is the signal.</Empty>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
                  {data.durable.map((c) => <DurableCardView key={c.ticker} card={c} onClick={() => onSelectTicker(c.ticker)} />)}
                </div>
              )}
              {/* WATCH strip — below participation floor (Part 2a). */}
              {data.watch.length > 0 && (
                <div style={{ marginTop: 8, padding: "6px 8px", background: "var(--bg-surface)", borderTop: "1px solid var(--bg-border)", fontSize: 11, color: "var(--text-muted)" }}>
                  ⚠ {data.watch.length} single-fund staircase{data.watch.length === 1 ? "" : "s"} below the participation floor —{" "}
                  {data.watch.slice(0, 8).map((w, i) => (
                    <span key={w.ticker}>{i > 0 ? " " : ""}<span onClick={() => onSelectTicker(w.ticker)} className="flows-row" style={{ color: "var(--color-info)", cursor: "pointer" }}>{w.ticker}</span> (n={w.holders})</span>
                  ))}{" "}— rendered as WATCH, not staged
                </div>
              )}
            </Section>
          )}

          {/* FORMING — confirmation runway scatter (6b). */}
          {show("FORMING") && (
            <Section title="Forming — confirmation runway" color={STAGE_COLOR.FORMING!} baseRate={data.baseRates.forming} count={data.forming.length} subtitle="x = streak age · y = accumulation slope (bps/qtr, cohort) · size = funds · amber ring = elite">
              {data.forming.length === 0 ? <Empty>None.</Empty> : <FormingRunway forming={data.forming} watch={data.watch} onSelectTicker={onSelectTicker} />}
            </Section>
          )}

          {/* SPIKES — magnitude-sorted lollipop by cohort bps (Part 5). */}
          {show("SPIKE") && (
            <Section title="Spikes" color={STAGE_COLOR.SPIKE!} count={data.spikes.count} subtitle="one-quarter moves — discount unless they persist; auto-promote to Forming next quarter if they hold">
              <SpikeLollipop spikes={data.spikes} onSelectTicker={onSelectTicker} />
            </Section>
          )}

          {/* TRANSITIONS — adaptive strand (≤30 events) / Sankey (6c). */}
          {show("STREAK ENDED") && data.transitions.length > 0 && (
            <Section title="Transitions this quarter" color="var(--text-secondary)" count={data.transitionsCount} subtitle="only actual stage changes — no X→X, no —→X">
              <TransitionsView
                transitions={data.transitions}
                formingTotal={data.census.find((c) => c.stage === "FORMING")?.count ?? 0}
                durableTotal={data.census.find((c) => c.stage === "DURABLE")?.count ?? 0}
                onSelectTicker={onSelectTicker}
              />
            </Section>
          )}

          {/* Core Holdings board — section below the pipeline (funnel CORE segment). */}
          {show("CORE") && (
            <>
              <div style={{ height: 1, background: "var(--bg-border)", margin: "4px 0" }} />
              <CoreHoldingsPanel period={period} onSelectTicker={onSelectTicker} />
            </>
          )}
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

/** Spikes as a magnitude-sorted lollipop by COHORT bps (Part 5c). Label keeps the
 *  intensity read (per-adder bps + adder count + elite stars); mega dimmed; tail
 *  collapsed to one line. */
function SpikeLollipop({ spikes, onSelectTicker }: { spikes: SpikesPayload; onSelectTicker: (t: string) => void }) {
  if (spikes.count === 0) return <Empty>None.</Empty>;
  const max = Math.max(1, ...spikes.items.map((s) => Math.abs(s.cohortBps ?? 0)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {spikes.items.map((s) => {
        const bps = s.cohortBps ?? 0;
        const w = Math.max(2, (Math.abs(bps) / max) * 100);
        return (
          <div key={s.ticker} onClick={() => onSelectTicker(s.ticker)} className="flows-row" style={{ display: "grid", gridTemplateColumns: "76px 1fr auto", gap: 8, alignItems: "center", padding: "2px 6px", cursor: "pointer", opacity: s.informational ? 0.55 : 1 }}>
            <span style={{ fontWeight: 700, fontSize: 11, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 3 }}>
              {s.ticker}
              {s.informational && <span title="mega-cap — informational only" style={{ fontSize: 7, textTransform: "uppercase", color: "var(--text-muted)", border: "1px solid var(--bg-border)", padding: "0 2px" }}>info</span>}
            </span>
            <div style={{ position: "relative", height: 10, background: "var(--bg-base)", border: "1px solid var(--bg-border)" }}>
              <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: `${w}%`, background: bps >= 0 ? "var(--color-info)" : "var(--color-negative)", opacity: 0.7 }} />
            </div>
            <span style={{ fontSize: 10, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "var(--text-secondary)", fontWeight: 700 }}>{bps >= 0 ? "+" : ""}{bps.toFixed(1)} bps</span>
              · {s.funds} fund{s.funds === 1 ? "" : "s"}
              {s.perAdderBps != null && ` · ~${(s.perAdderBps / 100).toFixed(1)}%/adder`}
              {s.eliteCount > 0 && <span style={{ color: "var(--color-accent)" }}>★{s.eliteCount}</span>}
              <FlagBadges flags={s.flags} />
            </span>
          </div>
        );
      })}
      {spikes.tail.count > 0 && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", padding: "3px 6px", borderTop: "1px dashed var(--bg-border)" }}>
          ＋{spikes.tail.count} more spike{spikes.tail.count === 1 ? "" : "s"}
          {spikes.tail.medianCohortBps != null && ` · median ${spikes.tail.medianCohortBps >= 0 ? "+" : ""}${spikes.tail.medianCohortBps} bps`}
        </div>
      )}
    </div>
  );
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
    <div onClick={onClick} className="flows-row" style={{ background: "var(--bg-surface)", border: "1px solid var(--bg-border)", padding: "8px 10px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 6, opacity: card.informational ? 0.55 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 700, color: "var(--color-positive)", fontSize: 14 }}>{card.ticker}</span>
          <CapTag tier={card.marketCapTier} />
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{Math.abs(card.streak)}q streak</span>
          {card.informational && <span title="mega-cap — informational only" style={{ fontSize: 8, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-muted)", border: "1px solid var(--bg-border)", padding: "0 3px" }}>info</span>}
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
