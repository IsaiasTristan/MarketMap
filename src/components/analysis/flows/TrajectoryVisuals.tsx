"use client";
/**
 * Trajectories v3 visual sections (Part 6):
 *  - PipelineFunnel (6a): proportional stage segments, QoQ deltas, click-to-filter,
 *    STREAK-ENDED delta green when falling. Fed by the same payload as the sections.
 *  - FormingRunway (6b): x=streak age, y=accumulation slope (bps/qtr cohort),
 *    size=funds, amber ring=elite, shaded promotion zone; below-floor watch names
 *    render as small faint unlabeled dots.
 *  - TransitionsView (6c): adaptive — a labeled STRAND diagram at ≤ strand_max real
 *    events, a clickable Sankey (band → member list) beyond it.
 * One participant vocabulary throughout: "N funds" (6d).
 */
import { useState } from "react";
import type { FormingChip, TransitionItem, WatchItem } from "@/server/services/institutional/institutional-query.service";

const STRAND_MAX = 30; // ≤ this many real events → strand; beyond → Sankey (6c)

const SEG_BG: Record<string, string> = {
  SPIKE: "#3a3a3a",
  FORMING: "#2f4f76",
  DURABLE: "#2f6fce",
  CORE: "#8a5a10",
  "STREAK ENDED": "#6e2a2a",
};
const STAGE_STROKE: Record<string, string> = {
  SPIKE: "#6a6a6a",
  FORMING: "#3d6ea5",
  DURABLE: "#2f6fce",
  CORE: "#ffb224",
  BROKEN: "#a33",
};

export interface FunnelSeg {
  stage: string;
  count: number;
  delta: number;
  fallingIsGood?: boolean;
}

// ── 6a: pipeline funnel ─────────────────────────────────────────────────────
export function PipelineFunnel({ segs, active, onToggle }: { segs: FunnelSeg[]; active: string | null; onToggle: (s: string) => void }) {
  return (
    <div>
      <div style={{ display: "flex", height: 46, margin: "4px 0" }}>
        {segs.map((s) => {
          const flex = Math.max(6, s.count);
          const deltaGood = s.fallingIsGood ? s.delta < 0 : s.delta > 0;
          const deltaColor = s.delta === 0 ? "var(--text-muted)" : deltaGood ? "var(--color-positive)" : "var(--color-negative)";
          const dimmed = active != null && active !== s.stage;
          return (
            <div
              key={s.stage}
              onClick={() => onToggle(s.stage)}
              title={`${s.count} names ${s.stage} — click to ${active === s.stage ? "clear filter" : "filter the page"}`}
              style={{ flex, minWidth: 80, height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 12px", background: SEG_BG[s.stage] ?? "#333", borderRight: "2px solid var(--bg-base)", cursor: "pointer", opacity: dimmed ? 0.4 : 1, outline: active === s.stage ? "2px solid var(--color-accent)" : "none" }}
            >
              <span style={{ fontSize: 10, letterSpacing: "0.06em", color: "rgba(255,255,255,.78)" }}>{s.stage}</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>
                {s.count}{" "}
                <span style={{ fontSize: 10, color: deltaColor }}>
                  {s.delta === 0 ? "±0" : `${s.delta > 0 ? "+" : ""}${s.delta}`}
                  {s.fallingIsGood && s.delta < 0 ? " ✓" : ""}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        width = names in stage · one query feeds the funnel AND the sections (chip == section by construction) · click a segment to filter · STREAK-ENDED falling renders green — fewer deaths is good · ex-mega default
      </div>
    </div>
  );
}

// ── 6b: forming confirmation runway ─────────────────────────────────────────
export function FormingRunway({ forming, watch, onSelectTicker }: { forming: FormingChip[]; watch: WatchItem[]; onSelectTicker: (t: string) => void }) {
  const W = 1100;
  const H = 280;
  const padL = 60;
  const padR = 20;
  const padT = 20;
  const padB = 40;
  const all = [...forming.map((f) => f.slopeBpsPerQtr), ...watch.map((w) => w.slopeBpsPerQtr), 0];
  const yMax = Math.max(1, ...all);
  const yMin = Math.min(0, ...all);
  const ageX = (streak: number, i: number): number => {
    // forming streak is 2 or 3; jitter within the column by index
    const age = Math.min(3, Math.max(2, Math.abs(streak)));
    const col = age === 2 ? 0.32 : 0.72;
    const jitter = (((i * 97) % 40) - 20) / 100 / 6; // deterministic ±
    return padL + (col + jitter) * (W - padL - padR);
  };
  const y = (slope: number): number => padT + (1 - (slope - yMin) / (yMax - yMin || 1)) * (H - padT - padB);
  const r = (holders: number): number => Math.max(3, Math.min(11, Math.sqrt(holders) * 2.4));
  // promotion zone: age 3 (right column) × top slope quartile.
  const slopes = forming.map((f) => f.slopeBpsPerQtr).sort((a, b) => a - b);
  const q75 = slopes.length ? slopes[Math.floor(0.75 * (slopes.length - 1))]! : yMax;
  const zoneX = padL + 0.55 * (W - padL - padR);
  const zoneY = padT;
  const zoneH = y(q75) - padT;
  // Label only the standouts to keep the dense low-slope cluster legible: the 12
  // most broadly-held names ∪ everything in the promotion zone (age 3 × top slope).
  const labelSet = new Set(
    [...forming].sort((a, b) => b.holders - a.holders || b.slopeBpsPerQtr - a.slopeBpsPerQtr).slice(0, 12).map((f) => f.ticker),
  );
  for (const f of forming) if (Math.abs(f.streak) >= 3 && f.slopeBpsPerQtr >= q75) labelSet.add(f.ticker);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }} role="img" aria-label="Forming names by streak age and accumulation slope">
        {/* promotion zone */}
        <rect x={zoneX} y={zoneY} width={W - padR - zoneX} height={Math.max(0, zoneH)} fill="rgba(47,111,206,0.08)" />
        <text x={W - padR} y={padT + 14} fill="var(--text-muted)" fontSize={11} textAnchor="end">promotion zone (age 3 × top-quartile slope)</text>
        {/* axes */}
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="var(--bg-border)" />
        <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="var(--bg-border)" />
        <text x={padL + 0.32 * (W - padL - padR)} y={H - padB + 20} fill="var(--text-muted)" fontSize={11} textAnchor="middle">2 quarters</text>
        <text x={padL + 0.72 * (W - padL - padR)} y={H - padB + 20} fill="var(--text-muted)" fontSize={11} textAnchor="middle">3 quarters — one filing from DURABLE</text>
        <text x={padL + 8} y={padT + 4} fill="var(--text-muted)" fontSize={11}>steep build ↑</text>
        {/* below-floor watch dots (faint, unlabeled) */}
        {watch.map((w, i) => (
          <circle key={`w${w.ticker}`} cx={ageX(w.streak, i + 500)} cy={y(w.slopeBpsPerQtr)} r={3} fill="var(--text-muted)" opacity={0.35}>
            <title>{`${w.ticker} — below participation floor (n=${w.holders})`}</title>
          </circle>
        ))}
        {/* forming dots — label only the standouts (elite or broadly-held) to avoid
            clutter in the dense low-slope cluster; the rest reveal on hover. */}
        {forming.map((f, i) => {
          const cx = ageX(f.streak, i);
          const cy = y(f.slopeBpsPerQtr);
          const rad = r(f.holders);
          const label = labelSet.has(f.ticker);
          return (
            <g key={f.ticker} style={{ cursor: "pointer" }} onClick={() => onSelectTicker(f.ticker)}>
              <circle cx={cx} cy={cy} r={rad} fill="#2f6fce" opacity={0.7} stroke={f.eliteCount > 0 ? "#ffb224" : "none"} strokeWidth={f.eliteCount > 0 ? 2 : 0}>
                <title>{`${f.ticker} · ${Math.abs(f.streak)}q streak · slope ${f.slopeBpsPerQtr >= 0 ? "+" : ""}${f.slopeBpsPerQtr} bps/qtr · ${f.holders} funds${f.eliteCount > 0 ? ` · ★${f.eliteCount} elite` : ""}`}</title>
              </circle>
              {label && (
                <text x={cx + rad + 3} y={cy + 4} fill="var(--text-secondary)" fontSize={11}>
                  {f.ticker}{f.holders >= 4 ? ` · ${f.holders} funds` : ""}{f.eliteCount > 0 ? " ★" : ""}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>hover any dot for its detail · faint small dots = below the 3-fund participation floor, never labeled · one vocabulary: "N funds" everywhere</div>
    </div>
  );
}

// ── 6c: transitions — adaptive strand / Sankey ──────────────────────────────
export function TransitionsView({ transitions, formingTotal, durableTotal, onSelectTicker }: { transitions: TransitionItem[]; formingTotal: number; durableTotal: number; onSelectTicker: (t: string) => void }) {
  const real = transitions.filter((t) => t.from && t.to && t.from !== t.to);
  if (real.length === 0) return <div style={{ fontSize: 11, color: "var(--text-muted)" }}>No stage changes this quarter.</div>;
  return real.length <= STRAND_MAX
    ? <StrandDiagram real={real} formingTotal={formingTotal} durableTotal={durableTotal} onSelectTicker={onSelectTicker} />
    : <SankeyTransitions real={real} onSelectTicker={onSelectTicker} />;
}

const TARGET_ORDER = ["SPIKE", "FORMING", "DURABLE", "CORE", "BROKEN"];
const TARGET_LABEL: Record<string, string> = { SPIKE: "→ SPIKE", FORMING: "→ FORMING", DURABLE: "→ DURABLE", CORE: "→ CORE", BROKEN: "STREAK ENDED" };
const TARGET_COLOR: Record<string, string> = { SPIKE: "var(--text-muted)", FORMING: "var(--color-info)", DURABLE: "var(--color-positive)", CORE: "var(--color-accent)", BROKEN: "var(--color-negative)" };

function StrandDiagram({ real, formingTotal, durableTotal, onSelectTicker }: { real: TransitionItem[]; formingTotal: number; durableTotal: number; onSelectTicker: (t: string) => void }) {
  const W = 700;
  const rowH = 15;
  const groups = TARGET_ORDER.map((to) => ({ to, items: real.filter((t) => t.to === to) })).filter((g) => g.items.length);
  const totalRows = groups.reduce((a, g) => a + g.items.length + 1, 0);
  const H = Math.max(220, 44 + totalRows * rowH + 30);
  const leftStages = ["SPIKE", "FORMING", "DURABLE", "CORE"];
  const leftY: Record<string, number> = {};
  leftStages.forEach((s, i) => { leftY[s] = 60 + i * ((H - 120) / (leftStages.length - 1)); });
  const groupTotal = (to: string) => (to === "FORMING" ? formingTotal : to === "DURABLE" ? durableTotal : null);

  let row = 44;
  const rightRows: Array<{ t: TransitionItem; y: number }> = [];
  const groupHeaders: Array<{ to: string; y: number; count: number }> = [];
  for (const g of groups) {
    groupHeaders.push({ to: g.to, y: row + 10, count: g.items.length });
    row += rowH;
    for (const t of g.items) { rightRows.push({ t, y: row }); row += rowH; }
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 900, height: "auto" }} role="img" aria-label="Named strands from last-quarter stage to this-quarter stage">
        <text x={24} y={20} fill="var(--text-primary)" fontSize={11} fontWeight={700} letterSpacing={1}>WAS <tspan fill="var(--text-muted)" fontWeight={400}>(last qtr)</tspan></text>
        <text x={W - 24} y={20} fill="var(--text-primary)" fontSize={11} fontWeight={700} letterSpacing={1} textAnchor="end">IS NOW <tspan fill="var(--text-muted)" fontWeight={400}>(this qtr)</tspan></text>
        <text x={W / 2} y={20} fill="var(--text-muted)" fontSize={10} textAnchor="middle">only stage CHANGES drawn — totals live in the funnel</text>
        {/* left stage nodes */}
        {leftStages.map((s) => (
          <g key={s}>
            <rect x={24} y={leftY[s]! - 10} width={8} height={20} fill={SEG_BG[s] ?? "#333"} />
            <text x={40} y={leftY[s]! - 1} fill="var(--text-secondary)" fontSize={11}>{s}</text>
            <text x={40} y={leftY[s]! + 11} fill="var(--text-muted)" fontSize={9}>{s === "SPIKE" ? "1q" : s === "FORMING" ? "2–3q" : s === "DURABLE" ? "4q+ streak" : "settled"}</text>
          </g>
        ))}
        {/* strands + right labels */}
        {rightRows.map(({ t, y }) => {
          const fy = leftY[t.from ?? "SPIKE"] ?? 60;
          const color = STAGE_STROKE[t.to ?? "FORMING"] ?? "#3d6ea5";
          return (
            <g key={`${t.ticker}-${y}`} style={{ cursor: "pointer" }} onClick={() => onSelectTicker(t.ticker)}>
              <path d={`M32 ${fy} C 320 ${fy} 360 ${y - 4} 540 ${y - 4}`} stroke={color} strokeWidth={t.to === "BROKEN" ? 1.8 : t.to === "DURABLE" || t.to === "CORE" ? 2.2 : 1.6} fill="none" opacity={0.85} />
              <text x={546} y={y} fill="var(--blue, #58a6ff)" fontSize={11} fontWeight={700}>
                {t.ticker}
                {t.elite ? <tspan fill="#ffb224"> ★</tspan> : null}
                {t.to === "BROKEN" ? <tspan fill="var(--text-muted)" fontWeight={400}> was {t.from}</tspan> : null}
              </text>
            </g>
          );
        })}
        {/* group headers on the right */}
        {groupHeaders.map((g) => (
          <text key={g.to} x={W - 24} y={g.y} fill={TARGET_COLOR[g.to] ?? "var(--text-secondary)"} fontSize={10} textAnchor="end">
            {TARGET_LABEL[g.to]} <tspan fontWeight={700}>+{g.count}</tspan>
            {groupTotal(g.to) != null ? <tspan fill="var(--text-muted)"> (of {groupTotal(g.to)})</tspan> : null}
          </text>
        ))}
        <text x={W / 2} y={H - 6} fill="var(--text-muted)" fontSize={10} textAnchor="middle">promotions move ONE rung — a 4q streak was a 3q streak last quarter · shorter failed builds exit silently (logged, not drawn)</text>
      </svg>
    </div>
  );
}

function SankeyTransitions({ real, onSelectTicker }: { real: TransitionItem[]; onSelectTicker: (t: string) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const W = 700;
  const H = 340;
  const fromStages = ["SPIKE", "FORMING", "DURABLE", "CORE"];
  const toStages = ["SPIKE", "FORMING", "DURABLE", "CORE", "BROKEN"];
  // band counts keyed from|to
  const bands = new Map<string, TransitionItem[]>();
  for (const t of real) {
    const k = `${t.from}|${t.to}`;
    (bands.get(k) ?? bands.set(k, []).get(k)!).push(t);
  }
  const nodeY = (stages: string[]) => {
    const m: Record<string, { y: number; h: number; n: number }> = {};
    const counts = stages.map((s) => real.filter((t) => (stages === fromStages ? t.from : t.to) === s).length);
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    let y = 30;
    stages.forEach((s, i) => { const h = Math.max(10, (counts[i]! / total) * (H - 60)); m[s] = { y, h, n: counts[i]! }; y += h + 10; });
    return m;
  };
  const L = nodeY(fromStages);
  const R = nodeY(toStages);
  const selItems = sel ? bands.get(sel) ?? [] : [];

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 640, height: "auto", flex: "1 1 420px" }} role="img" aria-label="Sankey of stage transitions">
        <text x={40} y={16} fill="var(--text-primary)" fontSize={11} fontWeight={700}>WAS</text>
        <text x={W - 40} y={16} fill="var(--text-primary)" fontSize={11} fontWeight={700} textAnchor="end">IS NOW</text>
        {fromStages.map((s) => L[s]!.n > 0 && (
          <g key={`l${s}`}>
            <rect x={30} y={L[s]!.y} width={10} height={L[s]!.h} fill={SEG_BG[s] ?? "#333"} />
            <text x={44} y={L[s]!.y + 12} fill="var(--text-secondary)" fontSize={10}>{s} {L[s]!.n}</text>
          </g>
        ))}
        {toStages.map((s) => R[s]!.n > 0 && (
          <g key={`r${s}`}>
            <rect x={W - 40} y={R[s]!.y} width={10} height={R[s]!.h} fill={SEG_BG[s === "BROKEN" ? "STREAK ENDED" : s] ?? "#333"} />
            <text x={W - 44} y={R[s]!.y + 12} fill="var(--text-secondary)" fontSize={10} textAnchor="end">{TARGET_LABEL[s]} {R[s]!.n}</text>
          </g>
        ))}
        {[...bands.entries()].map(([k, items]) => {
          const [f, t] = k.split("|");
          if (!L[f!] || !R[t!]) return null;
          const w = Math.max(1.5, (items.length / real.length) * 60);
          const y1 = L[f!]!.y + L[f!]!.h / 2;
          const y2 = R[t!]!.y + R[t!]!.h / 2;
          const on = sel === k;
          return (
            <path key={k} d={`M40 ${y1} C ${W / 2} ${y1} ${W / 2} ${y2} ${W - 40} ${y2}`} stroke={TARGET_COLOR[t!] ?? "#3d6ea5"} strokeWidth={w} fill="none" opacity={sel && !on ? 0.15 : 0.5} style={{ cursor: "pointer" }} onClick={() => setSel(on ? null : k)}>
              <title>{`${f} → ${t}: ${items.length} — click to list`}</title>
            </path>
          );
        })}
      </svg>
      <div style={{ flex: "1 1 200px", minWidth: 180, fontSize: 11 }}>
        {sel ? (
          <div>
            <div style={{ color: "var(--text-secondary)", fontWeight: 700, marginBottom: 4 }}>{sel.replace("|", " → ")} · {selItems.length} names</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {selItems.map((t) => (
                <span key={t.ticker} onClick={() => onSelectTicker(t.ticker)} className="flows-row" style={{ cursor: "pointer", border: "1px solid var(--bg-border)", padding: "1px 6px", color: "var(--text-secondary)" }}>
                  {t.ticker}{t.elite ? " ★" : ""}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ color: "var(--text-muted)" }}>{real.length} real state changes (&gt; {STRAND_MAX} → Sankey). Click a band to list its names — no dead-end bands.</div>
        )}
      </div>
    </div>
  );
}
