"use client";
/**
 * Pairs Validation screen (brief §10) — the pooled event study that tests the
 * tab's premise, honest to the point of being unflattering. The whole page is
 * horizon-aware: a single 4W/13W/26W toggle recomputes every panel (§A1/§A2),
 * every t-statistic tests the SAME two-way-demeaned excess the number shows
 * (§A5/§B4/§B5), null covariates get an explicit unclassified row (§B1), and a
 * permanent controls strip carries the known-answer / placebo / sign-flip /
 * concentration falsifiers (§C). The headline is split into in-sample and
 * observed-out-of-sample so the delta is the visible output (§D2).
 */
import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ValidationResult,
  DecayPoint,
  SliceRow,
  EngineRow,
  GroupStat,
  YearRow,
  DistPoint,
  CoverageRow,
  ControlsResult,
  SecondaryKindResult,
} from "@/lib/pairs/validation";
import { PairMetricTip } from "./PairMetricTip";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { Sparkline } from "@/components/analysis/research/primitives";
import { useMeasure } from "@/components/analysis/flows/quadrant/useMeasure";

const POS = "var(--color-positive)";
const NEG = "var(--color-negative)";
const MUT = "var(--text-muted)";
const ACC = "var(--color-accent)";

function useValidation() {
  return useQuery<ValidationResult | null>({
    queryKey: ["pairs-validation"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const r = await fetch("/api/analysis/pairs/validation");
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });
}

function pct(v: number | null | undefined, dp = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(dp)}%`;
}
function num(v: number | null | undefined, dp = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(dp);
}
function color(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "var(--text-primary)";
  return v > 0 ? POS : v < 0 ? NEG : "var(--text-primary)";
}
/** Pick the stat at the selected horizon, falling back to the primary. */
function pick(byHorizon: Record<number, GroupStat> | null | undefined, horizon: number, fallback: GroupStat): GroupStat {
  return byHorizon?.[horizon] ?? fallback;
}

const PANEL: React.CSSProperties = { border: "1px solid var(--chrome-border)", background: "var(--bg-surface)", padding: 10 };

function Stat({ label, value, tone, tip }: { label: string; value: string; tone?: string; tip?: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 1, minWidth: 78 }}>
      <span style={{ fontSize: 8.5, letterSpacing: 0.4, color: MUT, textTransform: "uppercase" }}>{tip ?? label}</span>
      <span className="bb-num" style={{ fontSize: 14, fontWeight: 700, color: tone ?? "var(--text-primary)" }}>{value}</span>
    </span>
  );
}

/** The global horizon toggle — drives every panel on the page. */
function HorizonToggle({ horizons, horizon, onChange }: { horizons: number[]; horizon: number; onChange: (h: number) => void }) {
  return (
    <span style={{ display: "inline-flex", border: "1px solid var(--chrome-border)" }}>
      {horizons.map((h) => (
        <button
          key={h}
          onClick={() => onChange(h)}
          style={{ fontSize: 9, fontWeight: 700, padding: "1px 7px", border: "none", cursor: "pointer", color: horizon === h ? "#000" : MUT, background: horizon === h ? ACC : "var(--bg-surface)" }}
        >
          {h}W
        </button>
      ))}
    </span>
  );
}

/** A horizontal bar centred on zero, scaled to a shared max. */
function MiniBar({ value, max, w = 74 }: { value: number | null; max: number; w?: number }) {
  const half = w / 2;
  const v = value ?? 0;
  const frac = max > 0 ? Math.max(-1, Math.min(1, v / max)) : 0;
  return (
    <span style={{ display: "inline-block", position: "relative", width: w, height: 9, background: "var(--bg-base)", verticalAlign: "middle" }}>
      <span style={{ position: "absolute", left: half, top: 0, bottom: 0, width: 1, background: "var(--chrome-border)" }} />
      <span
        style={{
          position: "absolute",
          top: 1.5,
          height: 6,
          width: Math.abs(frac) * half,
          background: v >= 0 ? POS : NEG,
          [v >= 0 ? "left" : "right"]: half,
        } as React.CSSProperties}
      />
    </span>
  );
}

/* ---- The claim + event rule + stat list ------------------------------- */

function PremisePanel({ v, horizon }: { v: ValidationResult; horizon: number }) {
  const h = v.headline;
  const s = pick(h.byHorizon, horizon, h.diagnosticStat);
  const inS = pick(v.splits.inSample.byHorizon, horizon, h.diagnosticStat);
  const oos = pick(v.splits.observedOutOfSample.byHorizon, horizon, h.diagnosticStat);
  const delta = s.excess !== null && inS.excess !== null && oos.excess !== null ? oos.excess - inS.excess : null;
  const row = (label: string, value: string, tone?: string, tip?: React.ReactNode) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "2px 0", borderBottom: "1px solid var(--chrome-border)" }}>
      <span style={{ fontSize: 9.5, color: "var(--text-secondary)" }}>{tip ?? label}</span>
      <span className="bb-num" style={{ fontSize: 12, fontWeight: 700, color: tone ?? "var(--text-primary)" }}>{value}</span>
    </div>
  );
  return (
    <ChartCard title="Is the premise true?" subtitle="One pooled test across every pair — not a pair leaderboard." fillHeight>
      <div style={{ height: "100%", overflow: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 10, color: "var(--text-secondary)", lineHeight: 1.5, border: "1px solid var(--chrome-border)", padding: "5px 7px", background: "var(--bg-base)" }}>
          <span style={{ color: ACC, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, fontSize: 8.5 }}>The claim being tested</span>
          <br />
          When the revision or inflection gap between two groups widens but the price ratio has not moved, the price ratio subsequently follows.
        </div>
        <div style={{ fontSize: 9.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          <span style={{ color: MUT, textTransform: "uppercase", letterSpacing: 0.4, fontSize: 8 }}>Event rule</span>
          <br />
          <span style={{ color: "var(--text-primary)" }}>{v.eventRule}</span>
        </div>
        {!h.ready && (
          <div style={{ fontSize: 9.5, color: ACC, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase" }}>
            Accruing — still short on {h.accruing.join(", ") || "—"} (numbers below are diagnostic, not a result yet)
          </div>
        )}
        <div>
          {row("events tested", String(s.events))}
          {row(`mean forward return, ${horizon}w (context)`, pct(s.mean), color(s.mean), <PairMetricTip id="forwardRelReturn">mean forward return, {horizon}w</PairMetricTip>)}
          {row("control (same pairs, other weeks)", pct(s.controlMean), color(s.controlMean))}
          {row("excess vs control (two-way demeaned)", pct(s.excess), color(s.excess))}
          {row("t-statistic (clustered by week)", num(s.tStat), color(s.tStat), <PairMetricTip id="effectiveSample">t-statistic (clustered by week)</PairMetricTip>)}
          {horizon >= 8 && row("non-overlapping cross-check t", `${num(s.nonOverlapTStat)} (${s.nonOverlapWeeks ?? "—"}w)`, color(s.nonOverlapTStat))}
          {row("hit rate (beats matched baseline)", pct(s.hitRate, 1), undefined, <PairMetricTip id="hitRate">hit rate</PairMetricTip>)}
          {row(`information coefficient (n=${s.icEvents})`, num(s.ic, 3), undefined, <PairMetricTip id="eventIC">information coefficient</PairMetricTip>)}
          {row("median forward return", pct(s.median), color(s.median))}
          {row("effective independent weeks", `${num(h.effectiveWeeks, 1)} / ${h.targets.effectiveWeeks}`, h.effectiveWeeks !== null && h.effectiveWeeks >= h.targets.effectiveWeeks ? POS : ACC)}
          {row("distinct pairs", `${h.distinctPairs} / ${h.targets.distinctPairs}`, h.distinctPairs >= h.targets.distinctPairs ? POS : ACC)}
        </div>
        {/* Two headlines — the in-sample vs observed-OOS delta is the output. */}
        <div style={{ border: "1px solid var(--chrome-border)", background: "var(--bg-base)", padding: "5px 7px" }}>
          <div style={{ fontSize: 8, textTransform: "uppercase", letterSpacing: 0.4, color: ACC, fontWeight: 700, marginBottom: 3 }}>
            In-sample vs observed out-of-sample · {horizon}w
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
            <span style={{ color: "var(--text-secondary)" }}>in-sample (&lt; {v.heldOutFrom})</span>
            <span className="bb-num" style={{ color: color(inS.excess), fontWeight: 700 }}>{pct(inS.excess)} · t {num(inS.tStat)} · {inS.events}ev</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
            <span style={{ color: "var(--text-secondary)" }}>observed OOS (&gt;= {v.heldOutFrom})</span>
            <span className="bb-num" style={{ color: color(oos.excess), fontWeight: 700 }}>{pct(oos.excess)} · t {num(oos.tStat)} · {v.splits.observedOutOfSample.eventsByHorizon[horizon] ?? oos.events}ev</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: MUT, marginTop: 2 }}>
            <span>delta (OOS − in-sample)</span>
            <span className="bb-num" style={{ color: color(delta), fontWeight: 700 }}>{pct(delta)}</span>
          </div>
          <div style={{ fontSize: 8, color: MUT, marginTop: 3, lineHeight: 1.4 }}>
            2026 is <b>observed</b> out-of-sample, not a pristine reserve — it has been inside the pooled view. OOS beating in-sample on a small sample is a hallmark of noise, not confirmation.
          </div>
        </div>
      </div>
    </ChartCard>
  );
}

/* ---- Decay curve with readouts ---------------------------------------- */

function DecayCurve({ v, horizon, height = 250 }: { v: ValidationResult; horizon: number; height?: number }) {
  const decay = v.decay;
  const [ref, measured] = useMeasure<HTMLDivElement>();
  const pts = decay.filter((d) => d.excess !== null);
  const w = Math.max(260, measured || 320);
  const hgt = height;
  const padL = 40;
  const padB = 22;
  const xs = decay.map((d) => d.horizon);
  const maxX = Math.max(...xs, 1);
  const allY = decay
    .flatMap((d) => [d.excess, d.excess !== null && d.stderr !== null ? d.excess + d.stderr : null, d.excess !== null && d.stderr !== null ? d.excess - d.stderr : null])
    .filter((y): y is number => y !== null && Number.isFinite(y));
  const maxY = Math.max(0.001, ...allY.map(Math.abs));
  const x = (hz: number) => padL + (hz / maxX) * (w - padL - 6);
  const y = (val: number) => (hgt - padB) / 2 - (val / maxY) * ((hgt - padB) / 2 - 8);
  const excessLine = decay.filter((d) => d.excess !== null).map((d, i) => `${i === 0 ? "M" : "L"}${x(d.horizon).toFixed(1)},${y(d.excess!).toFixed(1)}`).join(" ");
  const band = decay.filter((d) => d.excess !== null && d.stderr !== null);
  const bandPath =
    band.length > 1
      ? band.map((d, i) => `${i === 0 ? "M" : "L"}${x(d.horizon).toFixed(1)},${y(d.excess! + d.stderr!).toFixed(1)}`).join(" ") +
        " " +
        [...band].reverse().map((d) => `L${x(d.horizon).toFixed(1)},${y(d.excess! - d.stderr!).toFixed(1)}`).join(" ") +
        " Z"
      : "";

  const peak = pts.reduce<DecayPoint | null>((best, d) => (best === null || (d.excess ?? -Infinity) > (best.excess ?? -Infinity) ? d : best), null);
  const clears = decay.find((d) => d.excess !== null && d.stderr !== null && d.excess - d.stderr > 0) ?? null;
  const zeroY = y(0);
  const yticks = [maxY, maxY / 2, 0, -maxY / 2, -maxY];

  return (
    <ChartCard title="How fast does it show up, and when does it stop?" subtitle="Solid = two-way-demeaned excess · shaded = ±1 SE · dashed = control baseline (0 by construction)." fillHeight>
      <div ref={ref} style={{ width: "100%" }}>
        <svg viewBox={`0 0 ${w} ${hgt}`} width="100%" height={hgt} style={{ display: "block", background: "var(--bg-surface)" }}>
          {/* y-axis ticks */}
          {yticks.map((tv, i) => (
            <g key={`yt${i}`}>
              <line x1={padL} y1={y(tv)} x2={w - 6} y2={y(tv)} stroke="var(--chrome-border)" strokeWidth={0.5} opacity={tv === 0 ? 0 : 0.4} />
              <text x={padL - 3} y={y(tv) + 3} textAnchor="end" fontSize={7.5} fill={MUT}>{(tv * 100).toFixed(1)}%</text>
            </g>
          ))}
          {/* headline horizon marker */}
          <line x1={x(horizon)} y1={4} x2={x(horizon)} y2={hgt - padB} stroke="var(--chrome-border)" strokeWidth={1} strokeDasharray="2 3" />
          <text x={x(horizon) + 3} y={12} fontSize={8} fill={MUT}>HEADLINE {horizon}W</text>
          {/* zero / control line */}
          <line x1={padL} y1={zeroY} x2={w - 6} y2={zeroY} stroke={MUT} strokeWidth={1} strokeDasharray="3 3" />
          <text x={w - 8} y={zeroY - 3} textAnchor="end" fontSize={7.5} fill={MUT}>control = 0</text>
          {bandPath ? <path d={bandPath} fill={ACC} opacity={0.12} /> : null}
          <path d={excessLine} fill="none" stroke={ACC} strokeWidth={1.6} />
          {pts.map((d) => (
            <circle key={d.horizon} cx={x(d.horizon)} cy={y(d.excess!)} r={2} fill={ACC} />
          ))}
          {/* x ticks */}
          {decay.map((d) => (
            <text key={`xt${d.horizon}`} x={x(d.horizon)} y={hgt - padB + 12} textAnchor="middle" fontSize={8} fill={MUT}>{d.horizon}</text>
          ))}
          <text x={(padL + w - 6) / 2} y={hgt - 3} textAnchor="middle" fontSize={8.5} fill="var(--text-secondary)" letterSpacing={0.3}>WEEKS AFTER THE FLAG FIRED</text>
          <text x={11} y={(hgt - padB) / 2} textAnchor="middle" fontSize={8.5} fill="var(--text-secondary)" transform={`rotate(-90 11 ${(hgt - padB) / 2})`}>MEAN EXCESS (± 1 SE)</text>
        </svg>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 4, fontSize: 9, color: MUT }}>
        <span>edge peaks by <span style={{ color: "var(--text-primary)", fontWeight: 700 }}>~{peak ? `${peak.horizon}w` : "—"}</span></span>
        <span>band clears zero at <span style={{ color: clears ? POS : MUT, fontWeight: 700 }}>{clears ? `week ${clears.horizon}` : "not yet"}</span></span>
        <span>implied cadence <span style={{ color: "var(--text-primary)", fontWeight: 700 }}>weekly screen, ~{peak ? peak.horizon : horizon}w hold</span></span>
      </div>
    </ChartCard>
  );
}

/* ---- Which engine carries the result ---------------------------------- */

function EngineTable({ engines, horizon }: { engines: EngineRow[]; horizon: number }) {
  const statAt = (e: EngineRow): GroupStat | null => (e.stat ? pick(e.byHorizon, horizon, e.stat) : null);
  const maxAbs = Math.max(0.001, ...engines.map((e) => Math.abs(statAt(e)?.excess ?? 0)));
  return (
    <ChartCard title="Which engine is actually carrying the result?" subtitle="Partitioned on which event kind fired: E1 = UNPRICED (headline), E2 = E2_UNPRICED (restated-basis), BOTH = TRIANGULATED. Each row is that kind vs its own control." fillHeight>
      <div style={{ height: "100%", overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
          <thead>
            <tr style={{ color: MUT, textAlign: "right", fontSize: 8.5, letterSpacing: 0.3, textTransform: "uppercase" }}>
              <th style={{ textAlign: "left", padding: "0 6px" }}>Signal tested</th>
              <th style={{ padding: "0 6px" }}>excess {horizon}w</th>
              <th style={{ padding: "0 6px" }}>%</th>
              <th style={{ padding: "0 6px" }}>t</th>
              <th style={{ padding: "0 6px" }}>events</th>
              <th style={{ textAlign: "left", padding: "0 6px" }}>first event week</th>
            </tr>
          </thead>
          <tbody>
            {engines.map((e) => {
              const st = statAt(e);
              return (
                <tr key={e.engine} style={{ borderTop: "1px solid var(--chrome-border)", opacity: e.insufficient ? 0.5 : 1 }}>
                  <td style={{ padding: "3px 6px", color: "var(--text-secondary)" }}>{e.label}</td>
                  <td style={{ padding: "3px 6px", textAlign: "right" }}>{st && !e.insufficient ? <MiniBar value={st.excess} max={maxAbs} /> : "—"}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: color(st?.excess) }}>{st && !e.insufficient ? pct(st.excess) : "—"}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: color(st?.tStat) }}>{st && !e.insufficient ? num(st.tStat) : "—"}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: MUT }}>{st && !e.insufficient ? st.events : "—"}</td>
                  <td style={{ padding: "3px 6px", textAlign: "left", color: MUT, fontSize: 9 }}>{(st?.sampleStart ?? e.note) || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ fontSize: 9, color: "var(--text-secondary)", lineHeight: 1.5, marginTop: 6, borderTop: "1px solid var(--chrome-border)", paddingTop: 5 }}>
          Each row is a distinct event kind measured against its own control, so they do not sum. The E2 row is restated-basis and is never pooled with the Leg-B (E1) headline. When the engines triangulate (BOTH), the effect should be the strongest — the row to watch as the sample grows.
        </div>
      </div>
    </ChartCard>
  );
}

/* ---- Secondary event kinds -------------------------------------------- */

function SecondaryKinds({ kinds, horizon }: { kinds: SecondaryKindResult[]; horizon: number }) {
  if (!kinds || kinds.length === 0) return null;
  const cell = (s: GroupStat, gateReady: boolean) => (
    <>
      <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: gateReady ? color(s.excess) : MUT }}>{gateReady ? pct(s.excess) : "—"}</td>
      <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: gateReady ? color(s.tStat) : MUT }}>{gateReady ? num(s.tStat) : "—"}</td>
      <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: MUT }}>{s.events}</td>
    </>
  );
  return (
    <ChartCard
      title="Secondary event kinds"
      subtitle="Additive to the UNPRICED headline, each gated on its OWN three-part sample gate. Four looks at one dataset means the best-looking kind is partly luck — a reason to investigate, not a finding."
      compact
    >
      <div style={{ overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
          <thead>
            <tr style={{ color: MUT, textAlign: "right", fontSize: 8.5, letterSpacing: 0.3, textTransform: "uppercase" }}>
              <th style={{ textAlign: "left", padding: "0 6px" }}>Kind</th>
              <th style={{ padding: "0 6px" }}>marg excess {horizon}w</th>
              <th style={{ padding: "0 6px" }}>t</th>
              <th style={{ padding: "0 6px" }}>events</th>
              <th style={{ padding: "0 6px", borderLeft: "1px solid var(--chrome-border)" }}>excl excess</th>
              <th style={{ padding: "0 6px" }}>t</th>
              <th style={{ padding: "0 6px" }}>events</th>
              <th style={{ textAlign: "left", padding: "0 6px", borderLeft: "1px solid var(--chrome-border)" }}>gate</th>
            </tr>
          </thead>
          <tbody>
            {kinds.map((k) => {
              const marg = k.marginalByHorizon[horizon] ?? k.marginal;
              const excl = k.exclusiveByHorizon[horizon] ?? k.exclusive;
              const gateReady = k.gate.ready;
              return (
                <tr key={k.kind} style={{ borderTop: "1px solid var(--chrome-border)" }} title={k.note}>
                  <td style={{ padding: "2px 6px", color: "var(--text-secondary)" }}>
                    {k.label}
                    {k.restatedBasis ? (
                      <span title="restated-basis (reconstructed from restated statements); never pooled with Leg B" style={{ color: ACC, marginLeft: 4, fontSize: 8, letterSpacing: 0.3 }}>RESTATED-BASIS</span>
                    ) : null}
                  </td>
                  {cell(marg, gateReady)}
                  {cell(excl, gateReady)}
                  <td style={{ padding: "2px 6px", textAlign: "left", color: gateReady ? POS : ACC, fontSize: 9 }}>
                    {gateReady ? "ready" : `accruing — ${k.gate.accruing.join(", ") || "—"}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ fontSize: 8.5, color: MUT, marginTop: 5, lineHeight: 1.45 }}>
          <b>marg</b> = every week the kind fired (may overlap UNPRICED); <b>excl</b> = fired while UNPRICED did NOT, so the two never double-count the headline. CONTRARY is disjoint from UNPRICED by construction.
        </div>
      </div>
    </ChartCard>
  );
}

/* ---- Controls (falsifiers) -------------------------------------------- */

function ControlsPanel({ controls, fireRatePct, pairsFiringPct }: { controls: ControlsResult; fireRatePct: number; pairsFiringPct: number }) {
  const c = controls.concentration;
  return (
    <div style={{ ...PANEL, display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
      <div>
        <div style={{ fontSize: 8.5, textTransform: "uppercase", letterSpacing: 0.5, color: ACC, fontWeight: 700, marginBottom: 4 }}>
          Controls — is the test measuring anything? ({controls.horizon}w)
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
          <thead>
            <tr style={{ color: MUT, textAlign: "right", fontSize: 8, letterSpacing: 0.3, textTransform: "uppercase" }}>
              <th style={{ textAlign: "left", padding: "0 6px" }}>Control</th>
              <th style={{ padding: "0 6px" }}>excess</th>
              <th style={{ padding: "0 6px" }}>t</th>
              <th style={{ padding: "0 6px" }}>events</th>
              <th style={{ textAlign: "left", padding: "0 6px" }}>expectation</th>
            </tr>
          </thead>
          <tbody>
            {controls.rows.map((r) => (
              <tr key={r.key} style={{ borderTop: "1px solid var(--chrome-border)" }} title={r.note}>
                <td style={{ padding: "2px 6px", color: "var(--text-secondary)" }}>{r.label}</td>
                <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: color(r.excess) }}>{pct(r.excess)}</td>
                <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: color(r.tStat) }}>{num(r.tStat)}</td>
                <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: MUT }}>{r.events}</td>
                <td style={{ padding: "2px 6px", color: MUT, fontSize: 8.5 }}>{r.expectation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <div style={{ fontSize: 8.5, textTransform: "uppercase", letterSpacing: 0.5, color: ACC, fontWeight: 700, marginBottom: 4 }}>Concentration & fire rate</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <Stat label="max from one pair" value={String(c.maxEventsOnePair)} />
          <Stat label="mean / pair" value={num(c.meanEventsPerPair, 1)} />
          <Stat label="top-10 share" value={pct(c.top10SharePct === null ? null : c.top10SharePct / 100, 0)} />
          <Stat label="excess ex-top-10" value={pct(c.excessExTop10)} tone={color(c.excessExTop10)} />
          <Stat label="t ex-top-10" value={num(c.tStatExTop10)} tone={color(c.tStatExTop10)} />
        </div>
        <div style={{ fontSize: 8.5, color: MUT, marginTop: 6, lineHeight: 1.45 }}>
          UNPRICED fires on <b>{fireRatePct}%</b> of pair-weeks and <b>{pairsFiringPct}%</b> of pairs fire at least once — this is approximately a top-decile cut, not a rare configuration.
        </div>
      </div>
    </div>
  );
}

/* ---- Slices ----------------------------------------------------------- */

const DIM_LABELS: Record<string, string> = {
  tier: "By tier",
  hedgeEff: "By hedge efficiency",
  residualShare: "By stock-specific risk share",
  scope: "By sector scope",
  crowding: "By long-leg crowding (basket mean)",
  crowdBreadth: "By long-leg crowding breadth",
  valuation: "By valuation percentile",
  basketSize: "By basket size (smaller leg)",
  thinGap: "By gap-vs-noise floor",
  heldOut: "Observed out-of-sample",
};

function SliceTable({ v, horizon, onHorizon }: { v: ValidationResult; horizon: number; onHorizon: (h: number) => void }) {
  const slices = v.slices;
  const dims = [...new Set(slices.map((s) => s.dimension))];
  const excessAt = (s: SliceRow, hz: number): number | null => s.decay.find((d) => d.horizon === hz)?.excess ?? null;
  const maxAbs = Math.max(0.001, ...slices.map((s) => Math.abs(excessAt(s, horizon) ?? 0)));
  const rollupClamp = Math.max(0.001, ...slices.flatMap((s) => s.decay.map((d) => Math.abs(d.excess ?? 0))));
  const em = "—";

  return (
    <ChartCard title="Slicing the sample — where the effect lives" subtitle="Diagnosis, not a menu to pick the best row. Rows below the floor (events < 300 or |t| < 1) are dimmed; rows below the hard floor have stats suppressed." compact
      action={<HorizonToggle horizons={v.panelHorizons} horizon={horizon} onChange={onHorizon} />}
    >
      <div style={{ maxHeight: 470, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
          <thead style={{ position: "sticky", top: 0, background: "var(--bg-base)", zIndex: 1 }}>
            <tr style={{ color: MUT, textAlign: "right", fontSize: 8.5, letterSpacing: 0.3, textTransform: "uppercase" }}>
              <th style={{ textAlign: "left", padding: "3px 6px" }}>Slice of the sample</th>
              <th style={{ padding: "3px 6px" }}>Events</th>
              <th style={{ padding: "3px 6px" }}>excess {horizon}w</th>
              <th style={{ padding: "3px 6px" }}>excess</th>
              <th style={{ textAlign: "center", padding: "3px 6px" }}>decay 1→26w</th>
              <th style={{ padding: "3px 6px" }}>Median</th>
              <th style={{ padding: "3px 6px" }}><PairMetricTip id="hitRate">Hit</PairMetricTip></th>
              <th style={{ padding: "3px 6px" }}>t</th>
              <th style={{ padding: "3px 6px" }}><PairMetricTip id="eventIC">IC</PairMetricTip></th>
              <th style={{ textAlign: "left", padding: "3px 6px" }}>Starts</th>
              <th style={{ textAlign: "left", padding: "3px 6px" }}>What it suggests</th>
            </tr>
          </thead>
          <tbody>
            {dims.map((dim) => (
              <React.Fragment key={dim}>
                <tr>
                  <td colSpan={11} style={{ padding: "6px 6px 1px", fontSize: 8.5, letterSpacing: 0.4, color: ACC, textTransform: "uppercase" }}>
                    {DIM_LABELS[dim] ?? dim}
                  </td>
                </tr>
                {slices.filter((s) => s.dimension === dim).map((s) => {
                  const st = pick(s.byHorizon, horizon, s);
                  const ex = excessAt(s, horizon);
                  const sup = s.suppressed;
                  const disagree = horizon >= 8 && st.nonOverlapTStat !== null && st.tStat !== null && Math.sign(st.nonOverlapTStat) !== Math.sign(st.tStat);
                  return (
                    <tr key={`${dim}-${s.label}`} style={{ borderTop: "1px solid var(--chrome-border)", opacity: s.unclassified ? 0.6 : s.dimmed ? 0.4 : 1, fontStyle: s.unclassified ? "italic" : "normal" }} title={s.note}>
                      <td style={{ padding: "2px 6px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{s.label}</td>
                      <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right" }}>{s.events}</td>
                      <td style={{ padding: "2px 6px", textAlign: "right" }}><MiniBar value={ex} max={maxAbs} /></td>
                      <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: color(ex) }}>{pct(ex)}</td>
                      <td style={{ padding: "2px 6px", textAlign: "center" }}>
                        <Sparkline values={s.decay.map((d) => d.excess)} clamp={rollupClamp} color="var(--text-secondary)" />
                      </td>
                      <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: sup ? MUT : color(st.median) }}>{sup ? em : pct(st.median)}</td>
                      <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: MUT }}>{sup ? em : pct(st.hitRate, 0)}</td>
                      <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: sup ? MUT : color(st.tStat) }}>
                        {sup ? em : num(st.tStat)}{disagree ? <span title="non-overlapping cross-check disagrees in sign" style={{ color: ACC, marginLeft: 2 }}>!</span> : null}
                      </td>
                      <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: MUT }}>{sup ? em : num(st.ic, 3)}</td>
                      <td style={{ padding: "2px 6px", color: MUT, fontSize: 9 }}>{s.sampleStart ?? "—"}</td>
                      <td style={{ padding: "2px 6px", color: MUT, fontSize: 9 }}>{s.note}</td>
                    </tr>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

/* ---- Distribution ----------------------------------------------------- */

function Distribution({ v, horizon, height = 150 }: { v: ValidationResult; horizon: number; height?: number }) {
  const d: DistPoint = v.distribution.byHorizon[horizon] ?? v.distribution;
  const maxCount = Math.max(1, ...d.buckets.map((b) => b.count));
  const skewDir = d.skew === null ? "roughly symmetric" : d.skew > 0.05 ? "right-skewed (a few large winners pull the mean above the median)" : d.skew < -0.05 ? "left-skewed (a few large losers pull the mean below the median)" : "roughly symmetric";
  return (
    <ChartCard title={`Is it a shift or a few lucky outliers?`} subtitle={`Distribution of every event's forward excess (${horizon}w), bucketed.`} fillHeight>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height }}>
        {d.buckets.map((b, i) => (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end" }} title={`${b.label}: ${b.count}`}>
            <div style={{ width: "100%", height: `${(b.count / maxCount) * (height - 14)}px`, background: b.neg ? NEG : POS, opacity: 0.7 }} />
            <span style={{ fontSize: 7, color: MUT, marginTop: 1 }}>{b.label}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 8, color: MUT, textAlign: "center", marginTop: 1 }}>FORWARD LONG − SHORT RETURN, {horizon}W (%, bucketed)</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 6 }}>
        <Stat label="mean" value={pct(d.mean)} tone={color(d.mean)} />
        <Stat label="median" value={pct(d.median)} tone={color(d.median)} />
        <Stat label="skew" value={num(d.skew, 2)} />
        <Stat label="worst decile" value={pct(d.worstDecile)} tone={color(d.worstDecile)} />
        <Stat label="best decile" value={pct(d.bestDecile)} tone={color(d.bestDecile)} />
      </div>
      <div style={{ fontSize: 8.5, color: MUT, marginTop: 4 }}>Outcomes are {skewDir}; the mean/median gap ({num(d.meanOverMedian, 2)}×) is the tell.</div>
    </ChartCard>
  );
}

/* ---- Year by year ----------------------------------------------------- */

function YearByYear({ v, horizon }: { v: ValidationResult; horizon: number }) {
  if (v.yearByYear.length === 0) return null;
  const pooled = pick(v.headline.byHorizon, horizon, v.headline.diagnosticStat);
  const rows = v.yearByYear.map((y: YearRow) => y.byHorizon[horizon] ?? y.byHorizon[v.primaryHorizon]!);
  const maxAbs = Math.max(0.001, ...rows.flatMap((s) => [Math.abs(s.excess ?? 0), Math.abs(s.median ?? 0)]));
  const verdict = (s: GroupStat): { label: string; tone: string } => {
    if (s.excess === null || s.tStat === null) return { label: "—", tone: MUT };
    if (s.excess > 0 && s.tStat >= 1) return { label: "clears", tone: POS };
    return { label: "fails", tone: NEG };
  };
  return (
    <ChartCard title="Does it hold up in every year?" subtitle={`Excess ${horizon}w and median, year by year — is the edge carried by one regime?`} fillHeight>
      <div style={{ height: "100%", overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
          <thead>
            <tr style={{ color: MUT, textAlign: "right", fontSize: 8.5, letterSpacing: 0.3, textTransform: "uppercase" }}>
              <th style={{ textAlign: "left", padding: "0 6px" }}>Period</th>
              <th style={{ textAlign: "center", padding: "0 6px" }}>excess {horizon}w</th>
              <th style={{ padding: "0 6px" }}>excess</th>
              <th style={{ padding: "0 6px" }}>median</th>
              <th style={{ padding: "0 6px" }}>t</th>
              <th style={{ padding: "0 6px" }}>events</th>
              <th style={{ textAlign: "center", padding: "0 6px" }}>verdict</th>
            </tr>
          </thead>
          <tbody>
            {v.yearByYear.map((y: YearRow, i: number) => {
              const s = rows[i]!;
              const vd = verdict(s);
              const carries = pooled.tStat !== null && s.tStat !== null && Math.abs(s.tStat) > Math.abs(pooled.tStat);
              return (
                <tr key={y.year} style={{ borderTop: "1px solid var(--chrome-border)" }}>
                  <td style={{ padding: "2px 6px", fontWeight: 700 }}>{y.year}{carries ? <span title="subperiod t exceeds the pooled t — this year is carrying it" style={{ color: ACC, marginLeft: 3 }}>▲</span> : null}</td>
                  <td style={{ padding: "2px 6px", textAlign: "center" }}><MiniBar value={s.excess} max={maxAbs} /></td>
                  <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: color(s.excess) }}>{pct(s.excess)}</td>
                  <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: color(s.median) }}>{pct(s.median)}</td>
                  <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: color(s.tStat) }}>{num(s.tStat)}</td>
                  <td className="bb-num" style={{ padding: "2px 6px", textAlign: "right", color: MUT }}>{s.events}</td>
                  <td style={{ padding: "2px 6px", textAlign: "center", color: vd.tone, fontWeight: 700, fontSize: 9 }}>{vd.label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ fontSize: 8.5, color: MUT, marginTop: 5 }}>Clearing every period is the bar — a single year carrying everything (▲ = subperiod t above the pooled t) is a red flag, not a result.</div>
      </div>
    </ChartCard>
  );
}

/* ---- What the test cannot tell you ------------------------------------ */

function Caveats({ v }: { v: ValidationResult }) {
  return (
    <ChartCard title="What this test cannot tell you" subtitle="Coverage and caveats." style={{ borderColor: "var(--color-accent)" }} fillHeight>
      <div style={{ height: "100%", overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9 }}>
          <thead>
            <tr style={{ color: MUT, textAlign: "left", fontSize: 8, letterSpacing: 0.3, textTransform: "uppercase" }}>
              <th style={{ padding: "0 6px 3px 0" }}>Input</th>
              <th style={{ padding: "0 6px 3px" }}>From</th>
              <th style={{ padding: "0 6px 3px" }}>Depth</th>
              <th style={{ padding: "0 0 3px 6px" }}>Why</th>
            </tr>
          </thead>
          <tbody>
            {v.coverage.map((c: CoverageRow) => (
              <tr key={c.input} style={{ borderTop: "1px solid var(--chrome-border)" }}>
                <td style={{ padding: "2px 6px 2px 0", color: "var(--text-secondary)" }}>{c.input}</td>
                <td className="bb-num" style={{ padding: "2px 6px", color: MUT }}>{c.from ?? "—"}</td>
                <td style={{ padding: "2px 6px", color: c.depth === "full" ? POS : ACC }}>{c.depth}</td>
                <td style={{ padding: "2px 0 2px 6px", color: MUT }}>{c.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: 9, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          <li>The headline gates on <b>effective independent weeks</b> ({num(v.headline.effectiveWeeks, 1)}), not the {v.totals.events.toLocaleString()} raw events — overlapping horizons and many pairs per week are not independent.</li>
          <li>Leg B history is now <b>two vendors</b> (TipRanks + FMP, meshed point-in-time), which strengthens the early record but means the point-in-time story is no longer single-vendor.</li>
          <li><b>Current-taxonomy backfill bias:</b> historical basket membership uses today&apos;s subsector classifications, so a reclassified name sits in the wrong basket for its earlier history.</li>
          <li>Tier 2 <b>screened</b> and <b>unscreened</b> weeks are never pooled; the screened era only starts at the fundamental job&apos;s cutoff.</li>
          <li>A positive result here is a shift in the screen, not a backtested strategy: <b>no costs, borrow, or slippage</b>.</li>
        </ul>
      </div>
    </ChartCard>
  );
}

/* ---- Screen ----------------------------------------------------------- */

export function ValidationView() {
  const { data, isLoading, error } = useValidation();
  const [horizon, setHorizon] = useState<number>(4);
  const tested = useMemo(() => (data ? (data.headline.byHorizon[horizon] ?? data.headline.diagnosticStat).events : 0), [data, horizon]);
  if (isLoading) return <div style={{ fontSize: 11, color: MUT, padding: 16 }}>Loading validation…</div>;
  if (error) return <div style={{ fontSize: 11, color: NEG, padding: 16 }}>Failed to load validation.</div>;
  if (!data) {
    return (
      <div style={{ fontSize: 12, color: MUT, padding: 24, border: "1px solid var(--chrome-border)" }}>
        No pair snapshots yet. Run <code>npm run job:pairs-backfill</code> to populate the grid and compute the event study.
      </div>
    );
  }
  const dropped = data.totals.events - tested;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Test-run strip */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 20, ...PANEL }}>
        <span style={{ fontSize: 8.5, textTransform: "uppercase", letterSpacing: 0.5, color: ACC, fontWeight: 700 }}>Test run</span>
        <Stat label="span" value={`${data.span.start ?? "—"} → ${data.span.end ?? "—"}`} />
        <Stat label="held-out from" value={data.heldOutFrom || "—"} tone={ACC} />
        <Stat label="pair-weeks" value={data.totals.pairWeeks.toLocaleString()} />
        <Stat label="events" value={data.totals.events.toLocaleString()} />
        <Stat label={`tested @ ${horizon}w`} value={`${tested.toLocaleString()} · ${dropped} dropped`} />
        <Stat label="distinct pairs" value={String(data.totals.distinctPairs)} />
        <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 8.5, letterSpacing: 0.4, color: MUT, textTransform: "uppercase" }}>horizon</span>
          <HorizonToggle horizons={data.panelHorizons} horizon={horizon} onChange={setHorizon} />
        </span>
        <span style={{ marginLeft: "auto", fontSize: 8.5, color: MUT }}>one pooled test across every pair — {data.totals.events.toLocaleString()} events · {dropped} lack a complete {horizon}w forward window.</span>
      </div>

      {/* Row 1 — premise / decay / by engine */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 1fr)", gap: 6, minHeight: 320 }}>
        <PremisePanel v={data} horizon={horizon} />
        <DecayCurve v={data} horizon={horizon} height={252} />
        <EngineTable engines={data.engines} horizon={horizon} />
      </div>

      {/* Controls strip */}
      <ControlsPanel controls={data.controls} fireRatePct={data.fireRatePct} pairsFiringPct={data.pairsFiringPct} />

      {/* Secondary event kinds */}
      <SecondaryKinds kinds={data.secondaryKinds} horizon={horizon} />

      {/* Row 2 — slices */}
      <SliceTable v={data} horizon={horizon} onHorizon={setHorizon} />

      {/* Row 3 — distribution / year by year / caveats */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.1fr)", gap: 6, minHeight: 300 }}>
        <Distribution v={data} horizon={horizon} height={150} />
        <YearByYear v={data} horizon={horizon} />
        <Caveats v={data} />
      </div>
    </div>
  );
}
