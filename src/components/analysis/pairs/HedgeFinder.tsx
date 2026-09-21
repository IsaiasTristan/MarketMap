"use client";
/**
 * Hedge Finder screen (brief §9). Given a long ticker it shows, top to bottom:
 * an input strip with every gate visible, a three-panel row (what drives the
 * target · the hedge map of every candidate · before/after net loadings), the
 * candidates table (model + realised metrics, gated-out rows dimmed for
 * context), and a three-panel bottom row (basket composition · hedge-ratio
 * dependability · hedged-vs-unhedged equity curve). The short side is
 * signal-GATED but never a signal objective, and the colour convention on a
 * short's own signals is INVERTED — red (weak company) is good — stated up top.
 * Single-name short-interest / ADV / borrow are unavailable (Phase-0 probe), so
 * those columns are omitted and sector/subsector baskets stand in for the
 * deferred single-ticker ETF pool.
 */
import { useMemo, useState } from "react";
import { useHedge } from "./usePairs";
import type { HedgeCandidateRow, HedgeFinderResult } from "@/server/services/pairs/hedge-finder.service";
import { MACRO14_FACTORS } from "@/lib/factors/definitions/model-presets";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import { Sparkline } from "@/components/analysis/research/primitives";
import { DefinitionTooltip } from "@/components/analysis/ui/DefinitionTooltip";
import { PairMetricTip } from "./PairMetricTip";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { ChartFrame, type ChartPoint } from "@/components/analysis/ui/ChartFrame";
import { useMeasure } from "@/components/analysis/flows/quadrant/useMeasure";

const POS = "var(--color-positive)";
const NEG = "var(--color-negative)";
const MUT = "var(--text-muted)";
const ACC = "var(--color-accent)";

function pctS(v: number | null | undefined, dp = 0): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(dp)}%`;
}
function num(v: number | null | undefined, dp = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(dp);
}

function Stat({
  label,
  value,
  id,
  tone,
}: {
  label: string;
  value: string;
  id?: Parameters<typeof PairMetricTip>[0]["id"];
  tone?: "positive" | "negative" | "warning";
}) {
  const color = tone === "positive" ? POS : tone === "negative" ? NEG : tone === "warning" ? ACC : "var(--text-primary)";
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5, whiteSpace: "nowrap" }}>
      <span style={{ fontSize: 9, letterSpacing: 0.5, color: MUT, textTransform: "uppercase" }}>
        {id ? <PairMetricTip id={id}>{label}</PairMetricTip> : label}
      </span>
      <span className="bb-num" style={{ fontSize: 13, fontWeight: 700, color }}>{value}</span>
    </span>
  );
}

/* ---- What drives the target ------------------------------------------- */

function WhatDrives({ z, betas, rSquared }: { z: Record<string, number>; betas: Record<string, number>; rSquared: number }) {
  const factorShare = Math.max(0, Math.min(1, rSquared));
  return (
    <div style={{ height: "100%", overflow: "auto", display: "flex", flexDirection: "column" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 10, width: "100%" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", fontSize: 8, color: MUT, textTransform: "uppercase", padding: "0 4px 3px 0" }}>factor</th>
            <th style={{ textAlign: "center", fontSize: 8, color: MUT, textTransform: "uppercase", padding: "0 4px 3px" }}>sensitivity (universe z)</th>
            <th style={{ textAlign: "right", fontSize: 8, color: MUT, textTransform: "uppercase", padding: "0 0 3px 4px" }}>β</th>
          </tr>
        </thead>
        <tbody>
          {MACRO14_FACTORS.map((code) => {
            const def = getFactorDef(code);
            const zv = z[code] ?? 0;
            const frac = Math.max(-1, Math.min(1, zv / 2.5));
            return (
              <tr key={code}>
                <td style={{ padding: "1px 6px 1px 0", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                  <DefinitionTooltip def={{ id: code, label: def.label, short_def: def.description ?? "", calculation: def.howCalculated, basis: def.dataSource }}>{code}</DefinitionTooltip>
                </td>
                <td style={{ padding: "1px 4px" }}>
                  <span style={{ position: "relative", display: "block", width: "100%", minWidth: 90, height: 9, background: "var(--bg-base)" }}>
                    <span style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--chrome-border)" }} />
                    <span
                      style={{
                        position: "absolute",
                        top: 1.5,
                        height: 6,
                        width: `${Math.abs(frac) * 50}%`,
                        background: zv >= 0 ? POS : NEG,
                        [zv >= 0 ? "left" : "right"]: "50%",
                      } as React.CSSProperties}
                    />
                  </span>
                </td>
                <td className="bb-num" style={{ padding: "1px 0 1px 4px", textAlign: "right", color: "var(--text-primary)" }}>{(betas[code] ?? 0).toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {/* factor vs stock-specific split — only the factor part can be hedged */}
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 8, color: MUT, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>share of risk — only the factor part can be hedged</div>
        <div style={{ display: "flex", height: 14, border: "1px solid var(--chrome-border)" }}>
          <div style={{ width: `${factorShare * 100}%`, background: "rgba(74,154,240,0.5)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "var(--text-primary)" }}>
            FACTOR {(factorShare * 100).toFixed(0)}%
          </div>
          <div style={{ flex: 1, background: "var(--bg-base)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: MUT }}>
            STOCK-SPECIFIC {((1 - factorShare) * 100).toFixed(0)}%
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Hedge map -------------------------------------------------------- */

function decileFill(decile: number | null, gatePass: boolean): { fill: string; opacity: number } {
  if (!gatePass) return { fill: "var(--bg-surface)", opacity: 0 }; // hollow
  if (decile === null) return { fill: MUT, opacity: 0.7 };
  if (decile <= 3) return { fill: POS, opacity: 0.85 }; // weak name — good short
  if (decile >= 8) return { fill: NEG, opacity: 0.85 }; // strong name — bad short
  return { fill: ACC, opacity: 0.7 };
}

function HedgeMap({ candidates, height }: { candidates: HedgeCandidateRow[]; height: number }) {
  const zs = candidates.map((c) => c.signalZ).filter((z): z is number => z != null);
  const gateZ = useMemo(() => {
    if (zs.length < 4) return null;
    const sorted = [...zs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.33)] ?? null;
  }, [zs]);
  const yAbs = Math.max(1.5, ...zs.map((z) => Math.abs(z)));
  const xMax = Math.max(0.2, ...candidates.map((c) => c.totalVarRemovedPct));
  const xMin = Math.min(0, ...candidates.map((c) => c.totalVarRemovedPct));

  const points: ChartPoint[] = candidates.map((c) => {
    const { fill, opacity } = decileFill(c.decile, c.gatePass);
    return {
      id: c.key,
      x: c.totalVarRemovedPct,
      y: c.signalZ ?? 0,
      r: c.type === "BASKET" ? 4 : 3,
      shape: c.type === "BASKET" ? "square" : c.type === "ETF" ? "diamond" : "circle",
      fill: c.gatePass ? fill : "none",
      fillOpacity: opacity,
      stroke: c.gatePass ? "var(--bg-base)" : MUT,
      strokeWidth: c.gatePass ? 0.5 : 1,
      label: c.paretoFrontier || c.inBasket ? c.key.replace(" basket", "") : undefined,
      labelForced: c.inBasket,
      ring: c.inBasket,
      ringColor: NEG,
      def: {
        id: c.key,
        label: `${c.key}${c.type === "BASKET" ? " (basket)" : ""}`,
        short_def: `${pctS(c.totalVarRemovedPct)} of the long's total risk removed · factor risk removed ${pctS(c.factorRiskRemovedPct)}.`,
        calculation: `Own Engine-1 z ${num(c.signalZ)} · hedge ratio ${num(c.hedgeRatio)} · realised β ${num(c.realizedBeta)} (R² ${num(c.realizedR2)}).`,
        caveats: c.gatePass ? undefined : "Failed the short-side gate — shown for context, not a recommended short.",
        arithmetic: c.paretoFrontier ? "On the risk-removed vs signal-weakness frontier." : undefined,
      },
    };
  });

  // Pareto frontier polyline: frontier points sorted by x.
  const frontier = candidates
    .filter((c) => c.paretoFrontier)
    .map((c): [number, number] => [c.totalVarRemovedPct, c.signalZ ?? 0])
    .sort((a, b) => a[0] - b[0]);

  return (
    <ChartFrame
      height={height}
      xDomain={[xMin, xMax]}
      yDomain={[-yAbs, yAbs]}
      xTitle="SHARE OF THE LONG'S TOTAL RISK REMOVED → MORE RISK REMOVED"
      yTitle="HEDGE'S OWN E1 REVISION z — ↓ WEAKER = BETTER SHORT"
      xFmt={(v) => `${(v * 100).toFixed(0)}%`}
      yFmt={(v) => v.toFixed(1)}
      hlines={gateZ !== null ? [{ y: gateZ, label: "SIGNAL GATE — weak enough to short below", color: ACC }] : []}
      polylines={frontier.length >= 2 ? [{ points: frontier, color: ACC }] : []}
      quadrantLabels={[
        { x: xMax * 0.98, y: -yAbs * 0.8, text: "REMOVES RISK · WEAK NAME = BEST SHORT", color: POS, anchor: "end" },
        { x: xMax * 0.98, y: yAbs * 0.85, text: "STRONG NAME — DO NOT SHORT", color: NEG, anchor: "end" },
        { x: xMin + (xMax - xMin) * 0.02, y: yAbs * 0.85, text: "LITTLE RISK REMOVED", color: MUT, anchor: "start" },
      ]}
      points={points}
      footer="○ single name · □ sector/subsector basket · ◇ ETF (deferred — none ingested) · hollow = failed a gate · red ring = in the selected basket · dashed = Pareto frontier."
    />
  );
}

/* ---- Before / after --------------------------------------------------- */

function BeforeAfter({ before, after }: { before: Record<string, number>; after: Record<string, number> }) {
  const max = Math.max(0.1, ...MACRO14_FACTORS.flatMap((c) => [Math.abs(before[c] ?? 0), Math.abs(after[c] ?? 0)]));
  const bar = (v: number, color: string) => (
    <span style={{ display: "inline-block", position: "relative", width: 76, height: 8, background: "var(--bg-base)", verticalAlign: "middle" }}>
      <span style={{ position: "absolute", left: 38, top: 0, bottom: 0, width: 1, background: "var(--chrome-border)" }} />
      <span style={{ position: "absolute", top: 2, height: 4, width: Math.min(38, (Math.abs(v) / max) * 38), background: color, [v >= 0 ? "left" : "right"]: 38 } as React.CSSProperties} />
    </span>
  );
  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 10, width: "100%" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", fontSize: 8, color: MUT, textTransform: "uppercase", padding: "0 4px 3px 0" }}>factor</th>
            <th style={{ fontSize: 8, color: MUT, textTransform: "uppercase", padding: "0 2px 3px" }}>net (grey=long · orange=hedged)</th>
            <th style={{ textAlign: "right", fontSize: 8, color: MUT, textTransform: "uppercase", padding: "0 4px 3px" }}>before</th>
            <th style={{ textAlign: "right", fontSize: 8, color: MUT, textTransform: "uppercase", padding: "0 0 3px 4px" }}>after</th>
          </tr>
        </thead>
        <tbody>
          {MACRO14_FACTORS.map((code) => {
            const b = before[code] ?? 0;
            const a = after[code] ?? 0;
            return (
              <tr key={code}>
                <td style={{ padding: "1px 6px 1px 0", color: "var(--text-secondary)" }}>{code}</td>
                <td style={{ padding: "1px 2px" }}>
                  <span style={{ display: "inline-flex", flexDirection: "column", gap: 1 }}>
                    {bar(b, MUT)}
                    {bar(a, Math.abs(a) < Math.abs(b) ? ACC : NEG)}
                  </span>
                </td>
                <td className="bb-num" style={{ padding: "1px 4px", textAlign: "right", color: MUT }}>{b.toFixed(2)}</td>
                <td className="bb-num" style={{ padding: "1px 0 1px 4px", textAlign: "right", color: Math.abs(a) < Math.abs(b) ? POS : NEG }}>{a.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---- Ratio dependability ---------------------------------------------- */

function RatioChart({ rolling, model, height = 130 }: { rolling: Array<number | null>; model: number | null; height?: number }) {
  const [ref, measured] = useMeasure<HTMLDivElement>();
  const vals = rolling.filter((v): v is number => v != null);
  if (vals.length < 2) return <div style={{ fontSize: 10, color: MUT, padding: 8 }}>Not enough overlapping weeks for a rolling ratio.</div>;
  const all = model !== null ? [...vals, model] : vals;
  const lo = Math.min(...all, 0);
  const hi = Math.max(...all);
  const W = Math.max(240, measured || 320), H = height, PAD = 6;
  const n = rolling.length;
  const x = (i: number) => PAD + (i / (n - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo || 1)) * (H - 2 * PAD);
  let path = "";
  rolling.forEach((v, i) => {
    if (v == null) return;
    path += `${path === "" ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
  });
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block", background: "var(--bg-surface)", border: "1px solid var(--chrome-border)" }}>
        {model !== null && (
          <>
            <line x1={PAD} y1={y(model)} x2={W - PAD} y2={y(model)} stroke={ACC} strokeWidth={1} strokeDasharray="4 3" />
            <text x={W - PAD - 2} y={y(model) - 3} textAnchor="end" fontSize={8} fill={ACC}>model {model.toFixed(2)}</text>
          </>
        )}
        <path d={path} fill="none" stroke="var(--text-primary)" strokeWidth={1.3} />
        <text x={PAD} y={12} fontSize={8} fill={MUT}>rolling 52-week realised ratio</text>
      </svg>
    </div>
  );
}

/* ---- Hedged vs unhedged ----------------------------------------------- */

function HedgedVsUnhedged({ series, height = 130 }: { series: HedgeFinderResult["hedgedVsUnhedged"]; height?: number }) {
  const [ref, measured] = useMeasure<HTMLDivElement>();
  const { longIndex, hedgedIndex } = series;
  if (longIndex.length < 2) return <div style={{ fontSize: 10, color: MUT, padding: 8 }}>Not enough overlapping weeks.</div>;
  const all = [...longIndex, ...hedgedIndex];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const W = Math.max(240, measured || 320), H = height, PAD = 6;
  const x = (i: number) => PAD + (i / (longIndex.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo || 1)) * (H - 2 * PAD);
  const path = (arr: number[]) => arr.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ border: "1px solid var(--chrome-border)", background: "var(--bg-surface)", display: "block" }}>
        <path d={path(longIndex)} fill="none" stroke={MUT} strokeWidth={1.2} />
        <path d={path(hedgedIndex)} fill="none" stroke={ACC} strokeWidth={1.4} />
        <text x={W - 4} y={12} textAnchor="end" fontSize={8} fill={MUT}>grey = long alone · orange = hedged</text>
      </svg>
    </div>
  );
}

/** Worst peak-to-trough drawdown of an index series. */
function maxDrawdown(idx: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of idx) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.min(worst, v / peak - 1);
  }
  return worst;
}

/* ---- Candidates table ------------------------------------------------- */

type SortKey = "totalVarRemovedPct" | "factorRiskRemovedPct" | "volAfter" | "signalZ" | "realizedR2";

function readVerdict(c: HedgeCandidateRow): string {
  if (!c.gatePass) return c.e3Tag === "ACCUM" ? "gated — funds accumulating" : "gated — signal not weak";
  if (c.totalVarRemovedPct < 0) return "adds risk — skip";
  if (c.factorRiskRemovedPct > 0.7 && c.totalVarRemovedPct < 0.2) return "cancels factors, not total risk";
  if (c.type === "BASKET") return `removes ${pctS(c.totalVarRemovedPct)} of total risk — no single view`;
  return `removes ${pctS(c.totalVarRemovedPct)} · weak name`;
}

function CandidatesTable({ candidates, target }: { candidates: HedgeCandidateRow[]; target: string }) {
  const [sortKey, setSortKey] = useState<SortKey>("totalVarRemovedPct");
  const [asc, setAsc] = useState(false);
  const rows = useMemo(() => {
    const s = [...candidates].sort((a, b) => {
      const av = (a[sortKey] ?? -Infinity) as number;
      const bv = (b[sortKey] ?? -Infinity) as number;
      return asc ? av - bv : bv - av;
    });
    return s;
  }, [candidates, sortKey, asc]);

  const exportCsv = () => {
    const header = [
      "hedge", "type", "best_used", "hedge_ratio", "factor_risk_removed", "total_risk_removed",
      "vol_after", "residual_corr", "e1_z", "e2_decile", "e3_flow", "days_to_earnings",
      "realized_beta", "realized_r2", "beta_1h", "beta_2h", "gate_pass", "flags",
    ];
    const lines = rows.map((c) =>
      [
        c.key, c.type, c.bestMode, c.hedgeRatio, c.factorRiskRemovedPct, c.totalVarRemovedPct,
        c.volAfter, c.corrLongCand, c.signalZ ?? "", c.decile ?? "", c.e3Tag ?? "", c.daysToEarnings ?? "",
        c.realizedBeta ?? "", c.realizedR2 ?? "", c.betaFirstHalf ?? "", c.betaSecondHalf ?? "",
        c.gatePass, c.flags.join("|"),
      ].join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hedge-candidates-${target}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sortable = (label: string, key: SortKey, id?: Parameters<typeof PairMetricTip>[0]["id"]) => (
    <th
      onClick={() => (sortKey === key ? setAsc(!asc) : (setSortKey(key), setAsc(false)))}
      style={{ textAlign: "right", padding: "4px 6px", fontSize: 8.5, textTransform: "uppercase", color: sortKey === key ? ACC : MUT, borderBottom: "1px solid var(--chrome-border)", cursor: "pointer", whiteSpace: "nowrap" }}
    >
      {id ? <PairMetricTip id={id}>{label}</PairMetricTip> : label}
      {sortKey === key ? (asc ? " ▲" : " ▼") : ""}
    </th>
  );
  const groupTh = (label: string, span: number) => (
    <th colSpan={span} style={{ textAlign: "left", padding: "3px 6px", fontSize: 8, textTransform: "uppercase", letterSpacing: 0.5, color: ACC, borderBottom: "1px solid var(--chrome-border)", background: "var(--bg-base)" }}>
      {label}
    </th>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 9, color: MUT }}>
          Sorted by total risk removed · gated-out rows dimmed for context · <span style={{ color: ACC }}>red on a short&apos;s own signal is GOOD</span> (weak company).
        </span>
        <button onClick={exportCsv} style={{ fontSize: 9, textTransform: "uppercase", padding: "2px 8px", background: "var(--bg-surface)", color: "var(--text-secondary)", border: "1px solid var(--chrome-border)", cursor: "pointer" }}>· CSV</button>
      </div>
      <div style={{ overflow: "auto", border: "1px solid var(--chrome-border)", maxHeight: 420 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 10.5 }}>
          <thead style={{ position: "sticky", top: 0, background: "var(--bg-base)", zIndex: 1 }}>
            <tr>
              {groupTh("The hedge", 4)}
              {groupTh("How much risk it removes", 4)}
              {groupTh("Sensible short? (gate only)", 3)}
              {groupTh("Return history agrees?", 4)}
              {groupTh("Read", 2)}
            </tr>
            <tr>
              <th style={{ textAlign: "left", padding: "4px 6px", fontSize: 8.5, textTransform: "uppercase", color: MUT, borderBottom: "1px solid var(--chrome-border)" }}>hedge</th>
              <th style={{ textAlign: "left", padding: "4px 6px", fontSize: 8.5, textTransform: "uppercase", color: MUT, borderBottom: "1px solid var(--chrome-border)" }}>type</th>
              <th style={{ textAlign: "left", padding: "4px 6px", fontSize: 8.5, textTransform: "uppercase", color: MUT, borderBottom: "1px solid var(--chrome-border)" }}>best used</th>
              {sortable("ratio", "totalVarRemovedPct", "hedgeRatio")}
              {sortable("factor risk", "factorRiskRemovedPct", "factorRiskRemoved")}
              {sortable("total risk", "totalVarRemovedPct", "totalRiskRemoved")}
              {sortable("vol after", "volAfter")}
              <th style={{ textAlign: "right", padding: "4px 6px", fontSize: 8.5, textTransform: "uppercase", color: MUT, borderBottom: "1px solid var(--chrome-border)" }}><PairMetricTip id="residualCorrelation">resid corr</PairMetricTip></th>
              {sortable("E1 z", "signalZ")}
              <th style={{ textAlign: "right", padding: "4px 6px", fontSize: 8.5, textTransform: "uppercase", color: MUT, borderBottom: "1px solid var(--chrome-border)" }}>E2 dec</th>
              <th style={{ textAlign: "right", padding: "4px 6px", fontSize: 8.5, textTransform: "uppercase", color: MUT, borderBottom: "1px solid var(--chrome-border)" }}>13F</th>
              <th style={{ textAlign: "right", padding: "4px 6px", fontSize: 8.5, textTransform: "uppercase", color: MUT, borderBottom: "1px solid var(--chrome-border)" }}><PairMetricTip id="empiricalBeta">real β</PairMetricTip></th>
              {sortable("R²", "realizedR2")}
              <th style={{ textAlign: "right", padding: "4px 6px", fontSize: 8.5, textTransform: "uppercase", color: MUT, borderBottom: "1px solid var(--chrome-border)" }}><PairMetricTip id="splitHalfRatio">1h / 2h</PairMetricTip></th>
              <th style={{ textAlign: "center", padding: "4px 6px", fontSize: 8.5, textTransform: "uppercase", color: MUT, borderBottom: "1px solid var(--chrome-border)" }}><PairMetricTip id="rollingRatio">rolling</PairMetricTip></th>
              <th style={{ textAlign: "left", padding: "4px 6px", fontSize: 8.5, textTransform: "uppercase", color: MUT, borderBottom: "1px solid var(--chrome-border)" }}>verdict</th>
              <th style={{ textAlign: "left", padding: "4px 6px", fontSize: 8.5, textTransform: "uppercase", color: MUT, borderBottom: "1px solid var(--chrome-border)" }}>flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const dim = !c.gatePass;
              const clamp = Math.max(1, ...c.rolling52.map((v) => (v === null ? 0 : Math.abs(v))));
              return (
                <tr key={c.key} style={{ opacity: dim ? 0.5 : 1, borderBottom: "1px solid var(--chrome-border)" }}>
                  <td style={{ padding: "3px 6px", fontWeight: 700, color: NEG, whiteSpace: "nowrap" }}>{c.key}</td>
                  <td style={{ padding: "3px 6px", color: MUT }}>{c.type === "BASKET" ? "basket" : c.type === "ETF" ? "ETF" : "name"}</td>
                  <td style={{ padding: "3px 6px", color: "var(--text-secondary)", textTransform: "uppercase", fontSize: 9 }}>{c.bestMode}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right" }}>{num(c.hedgeRatio)}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: c.factorRiskRemovedPct > 0 ? POS : NEG }}>{pctS(c.factorRiskRemovedPct)}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", fontWeight: 700, color: c.totalVarRemovedPct > 0 ? POS : NEG }}>{pctS(c.totalVarRemovedPct)}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: MUT }}>{pctS(c.volAfter)}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: MUT }}>{num(c.corrLongCand)}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: c.signalZ != null && c.signalZ < 0 ? POS : "var(--text-primary)" }}>{num(c.signalZ)}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: c.decile != null && c.decile <= 3 ? POS : MUT }}>{c.decile ?? "—"}</td>
                  <td style={{ padding: "3px 6px", textAlign: "right", color: c.e3Tag === "ACCUM" ? NEG : MUT, fontSize: 9 }}>{c.e3Tag ?? "—"}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: MUT }}>{num(c.realizedBeta)}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: MUT }}>{num(c.realizedR2)}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: MUT }}>{num(c.betaFirstHalf)} / {num(c.betaSecondHalf)}</td>
                  <td style={{ padding: "3px 6px", textAlign: "center" }}>
                    {c.rolling52.some((v) => v != null) ? <Sparkline values={c.rolling52} clamp={clamp} color="var(--text-secondary)" /> : <span style={{ color: MUT }}>—</span>}
                  </td>
                  <td style={{ padding: "3px 6px", color: "var(--text-secondary)", fontSize: 9, whiteSpace: "nowrap" }}>{readVerdict(c)}</td>
                  <td style={{ padding: "3px 6px", fontSize: 8.5 }}>
                    {c.flags.map((f) => (
                      <span key={f} style={{ marginRight: 3, color: f === "ON FRONTIER" ? ACC : f === "UNSTABLE RATIO" ? NEG : MUT, border: "1px solid var(--chrome-border)", padding: "0 3px" }}>{f}</span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---- Basket composition ----------------------------------------------- */

function BasketComposition({ legs, target }: { legs: HedgeFinderResult["legs"]; target: string }) {
  const gross = legs.reduce((s, l) => s + l.weight, 0) || 1;
  const within30 = legs.filter((l) => l.daysToEarnings != null && l.daysToEarnings <= 30).length;
  const zs = legs.map((l) => l.signalZ).filter((z): z is number => z != null);
  const avgZ = zs.length ? zs.reduce((s, z) => s + z, 0) / zs.length : null;
  return (
    <div style={{ height: "100%", overflow: "auto", display: "flex", flexDirection: "column" }}>
      {legs.length === 0 ? (
        <div style={{ fontSize: 10, color: MUT, padding: 8 }}>No gated candidate reduced factor risk — try Express mode or more names.</div>
      ) : (
        <>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 10 }}>
            <thead>
              <tr>
                {["short", "wt", "$/$1", "offsets", "E1 z", "E2", "ER"].map((h, i) => (
                  <th key={h} style={{ textAlign: i === 0 ? "left" : "right", padding: "2px 5px 3px", fontSize: 8, textTransform: "uppercase", color: MUT, borderBottom: "1px solid var(--chrome-border)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {legs.map((l) => (
                <tr key={l.ticker}>
                  <td style={{ padding: "2px 5px", fontWeight: 700, color: NEG }}>{l.ticker}</td>
                  <td className="bb-num" style={{ padding: "2px 5px", textAlign: "right" }}>{((l.weight / gross) * 100).toFixed(0)}%</td>
                  <td className="bb-num" style={{ padding: "2px 5px", textAlign: "right", color: MUT }}>{l.weight.toFixed(2)}</td>
                  <td style={{ padding: "2px 5px", textAlign: "right", color: "var(--text-secondary)", fontSize: 9 }}>{l.offsetsFactor ?? "—"}</td>
                  <td className="bb-num" style={{ padding: "2px 5px", textAlign: "right", color: l.signalZ != null && l.signalZ < 0 ? POS : "var(--text-primary)" }}>{num(l.signalZ)}</td>
                  <td style={{ padding: "2px 5px", textAlign: "right", color: l.e2Tag === "TRAP" ? POS : MUT, fontSize: 9 }}>{l.e2Tag ?? "—"}</td>
                  <td className="bb-num" style={{ padding: "2px 5px", textAlign: "right", color: l.daysToEarnings != null && l.daysToEarnings <= 30 ? ACC : MUT }}>{l.daysToEarnings != null ? `${l.daysToEarnings}d` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: "auto", paddingTop: 6, borderTop: "1px solid var(--chrome-border)", display: "flex", flexWrap: "wrap", gap: 12, fontSize: 9, color: MUT }}>
            <span>gross short <span className="bb-num" style={{ color: "var(--text-primary)", fontWeight: 700 }}>${gross.toFixed(2)}</span> / $1 {target}</span>
            <span>avg E1 z <span className="bb-num" style={{ color: avgZ != null && avgZ < 0 ? POS : "var(--text-primary)", fontWeight: 700 }}>{num(avgZ)}</span></span>
            <span>report ≤30d <span className="bb-num" style={{ color: "var(--text-primary)", fontWeight: 700 }}>{within30}/{legs.length}</span></span>
          </div>
        </>
      )}
    </div>
  );
}

/* ---- Screen ----------------------------------------------------------- */

export function HedgeFinder() {
  const [input, setInput] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [mode, setMode] = useState<"neutralize" | "express">("neutralize");
  const [maxNames, setMaxNames] = useState(8);
  const { data, state, error } = useHedge(target, mode, maxNames);

  const submit = () => setTarget(input.trim().toUpperCase() || null);

  const volAfter = data ? data.target.modelVol * Math.sqrt(Math.max(0, 1 - data.totalVarRemovedPct)) : 0;
  const ddHedged = data && data.hedgedVsUnhedged.hedgedIndex.length > 1 ? maxDrawdown(data.hedgedVsUnhedged.hedgedIndex) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Input strip */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "6px 10px", border: "1px solid var(--chrome-border)", background: "var(--bg-surface)" }}>
        <span style={{ fontSize: 9, textTransform: "uppercase", color: MUT }}>stock you are long</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="e.g. AAPL"
          style={{ fontSize: 12, background: "var(--bg-base)", color: "var(--text-primary)", border: "1px solid var(--chrome-border)", padding: "3px 8px", width: 130 }}
        />
        <button onClick={submit} style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "3px 12px", background: ACC, color: "#000", border: "none", cursor: "pointer" }}>Find hedge</button>
        <span style={{ display: "inline-flex", border: "1px solid var(--chrome-border)" }}>
          {(["neutralize", "express"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", padding: "2px 8px", border: "none", cursor: "pointer", color: mode === m ? "#000" : MUT, background: mode === m ? ACC : "var(--bg-surface)" }}>{m === "neutralize" ? "Neutralize risk" : "Express thesis"}</button>
          ))}
        </span>
        <label style={{ fontSize: 9, textTransform: "uppercase", color: MUT, display: "inline-flex", alignItems: "center", gap: 4 }}>
          max names
          <input type="number" min={1} max={12} value={maxNames} onChange={(e) => setMaxNames(Math.max(1, Math.min(12, Number(e.target.value) || 8)))} style={{ width: 42, fontSize: 11, background: "var(--bg-base)", color: "var(--text-primary)", border: "1px solid var(--chrome-border)", padding: "2px 4px" }} />
        </label>
        {data && (
          <span style={{ fontSize: 9, color: MUT, marginLeft: "auto" }}>
            pool: same sector ({data.candidatePoolSize}) · gate E1 dec ≤ {data.gates.weakMaxDecile} or E2 TRAP · no E3 accum · <span style={{ color: POS }}>{data.candidatePoolSize - data.gatedOut} pass</span> · β-shrink λ={data.gates.betaShrinkLambda} · cap {(data.gates.nameCap * 100).toFixed(0)}%
          </span>
        )}
      </div>

      {data && <div style={{ fontSize: 9, color: ACC, padding: "0 10px" }}>{data.subtitle}</div>}

      {state === "idle" && <div style={{ fontSize: 12, color: MUT, padding: 24, border: "1px solid var(--chrome-border)" }}>Enter a long ticker to build a risk-only hedge basket and rank every candidate short.</div>}
      {state === "loading" && <div style={{ fontSize: 12, color: MUT, padding: 24 }}>Solving…</div>}
      {state === "error" && <div style={{ fontSize: 12, color: NEG, padding: 24, border: "1px solid var(--chrome-border)" }}>{String((error as Error)?.message ?? "Failed")}</div>}
      {state === "empty" && <div style={{ fontSize: 12, color: MUT, padding: 24, border: "1px solid var(--chrome-border)" }}>No factor grid or no row for that ticker. Ensure it is in the active universe and the MACRO14 grid is precomputed.</div>}

      {data && (
        <>
          {/* Headline strip */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 20, padding: "6px 10px", border: "1px solid var(--chrome-border)", background: "var(--bg-surface)" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{data.target.ticker}</span>
            <span style={{ fontSize: 10, color: MUT }}>{data.target.name} · {data.target.subsector}</span>
            <div style={{ flex: 1 }} />
            <Stat label="vol before" value={pctS(data.target.modelVol)} />
            <Stat label="vol after" value={pctS(volAfter)} tone={volAfter < data.target.modelVol ? "positive" : "negative"} />
            <Stat label="factor risk removed" id="factorRiskRemoved" value={pctS(data.factorRiskRemovedPct)} tone="positive" />
            <Stat label="total risk removed" id="totalRiskRemoved" value={pctS(data.totalVarRemovedPct)} tone={data.totalVarRemovedPct > 0 ? "positive" : "negative"} />
            <Stat label="residual" id="residualShare" value={`${data.residualSharePct.toFixed(0)}%`} />
          </div>

          <div style={{ fontSize: 11, color: "var(--text-primary)", padding: "6px 10px", border: "1px solid var(--color-accent)", background: "rgba(240,182,93,0.06)" }}>
            {data.survivorStatement}
          </div>

          {/* Three-panel row */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.85fr) minmax(0, 1.4fr) minmax(0, 0.95fr)", gap: 6, minHeight: 300 }}>
            <ChartCard title={`What drives ${data.target.ticker}`} subtitle="Sensitivity to each of the 14 macro/style factors; only the factor share of risk can be hedged away." fillHeight>
              <WhatDrives z={data.targetFactorZ} betas={data.factorBefore} rSquared={data.target.rSquared} />
            </ChartCard>
            <ChartCard title="Hedge map — every candidate on one chart" subtitle="Right removes more risk; down = the short's own signal is weaker (better). Shape = type, fill = E1 decile, hollow = failed a gate." fillHeight>
              <HedgeMap candidates={data.candidates} height={300} />
            </ChartCard>
            <ChartCard title="Before / after the hedge" subtitle="Net factor loadings with the short basket applied; what is left is the bet." fillHeight>
              <BeforeAfter before={data.factorBefore} after={data.factorAfter} />
            </ChartCard>
          </div>

          {/* Candidates table */}
          <ChartCard title={`Hedge candidates — ${data.candidates.length} shown of ${data.candidatePoolSize} in sector`} compact>
            <CandidatesTable candidates={data.candidates} target={data.target.ticker} />
          </ChartCard>

          {/* Bottom three-panel row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6, minHeight: 220 }}>
            <ChartCard title={`In the basket — ${data.legs.length} shorts`} subtitle="Constituents, weight, dollars per $1 long, the factor each offsets most, own signals and next report." fillHeight>
              <BasketComposition legs={data.legs} target={data.target.ticker} />
            </ChartCard>
            <ChartCard title="Is the hedge ratio dependable?" subtitle="Rolling 52-week realised ratio vs the model-implied constant." fillHeight>
              <RatioChart rolling={data.empirical.rolling52} model={data.empirical.realizedBeta} height={150} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6, fontSize: 9, color: MUT }}>
                <span>realised β <span className="bb-num" style={{ color: "var(--text-primary)", fontWeight: 700 }}>{num(data.empirical.realizedBeta)}</span></span>
                <span>R² <span className="bb-num" style={{ color: "var(--text-primary)", fontWeight: 700 }}>{num(data.empirical.realizedR2)}</span></span>
                <span>1h/2h <span className="bb-num" style={{ color: "var(--text-primary)", fontWeight: 700 }}>{num(data.empirical.betaFirstHalf)} / {num(data.empirical.betaSecondHalf)}</span></span>
                <span style={{ color: data.empirical.splitHalfRatio != null && Math.abs(data.empirical.splitHalfRatio - 1) > 0.5 ? NEG : POS, fontWeight: 700, textTransform: "uppercase" }}>
                  {data.empirical.splitHalfRatio != null && Math.abs(data.empirical.splitHalfRatio - 1) > 0.5 ? "unstable" : "stable"}
                </span>
              </div>
            </ChartCard>
            <ChartCard title="Hedged vs unhedged, last 2 years" subtitle="Indexed long alone vs the hedged position." fillHeight>
              <HedgedVsUnhedged series={data.hedgedVsUnhedged} height={150} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6, fontSize: 9, color: MUT }}>
                <span>worst drawdown <span className="bb-num" style={{ color: NEG, fontWeight: 700 }}>{ddHedged !== null ? pctS(ddHedged, 1) : "—"}</span></span>
                <span>weeks used <span className="bb-num" style={{ color: "var(--text-primary)", fontWeight: 700 }}>{data.empirical.weeksUsed}</span></span>
              </div>
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}
