"use client";
/**
 * Pairs tab — the ranked pair table (mockup PAIR RANK). One row per oriented
 * pair: a two-line long/short cell with per-leg name counts, sector, a hedge-
 * efficiency bar, the Engine 1/2/3 gap columns, adjacent signal-gap and price-
 * ratio sparklines (the adjacency is the point), share-price returns, the
 * unpriced gap with a fixed-scale heat fill, a valuation-percentile track, the
 * Engine 4 factor decomposition, crowding, and the READ flags. Filter chips
 * (ALL / NEW THIS WEEK / UNPRICED ONLY / hide factor bets), sortable headers
 * and CSV export are client-side over the fetched rows. Nothing computes a
 * signal — it reads PairSnapshot fields.
 */
import { useMemo, useState } from "react";
import type { PairRowPayload } from "@/server/services/pairs/pairs-read.service";
import { Sparkline, Tag, signColor } from "@/components/analysis/research/primitives";
import { PairMetricTip } from "./PairMetricTip";
import { pairMetric, type PairMetricId } from "@/lib/pairs/metric-registry";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";
import { capByLeg } from "@/lib/pairs/rank-display";
import { formatGapPp } from "@/lib/pairs/labels";

const pp = (v: number | null, d = 0) => (v === null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}`);
const pct = (v: number | null, d = 1) =>
  v === null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

/** pp of breadth a single name flipping cut→raise moves on a leg of size n. */
function nameStepPp(n: number | null): number | null {
  return n != null && Number.isFinite(n) && n > 0 ? 200 / n : null;
}

function arrow(change: number | null): string {
  if (change === null || !Number.isFinite(change)) return "";
  if (Math.abs(change) < PAIR_THRESHOLDS.gapMoveArrowPp) return "";
  return change > 0 ? " ▲" : " ▼";
}

/**
 * Trailing weeks the series has not moved. Engine 2 (inflection) is reconstructed
 * on a quarterly fundamentals cadence, so its breadth is flat between refreshes and
 * a 4-week diff is legitimately 0 — this lets the column say "no refresh" rather
 * than render a 0 that reads as "measured, no change".
 */
function trailingFlatWeeks(series: number[]): number {
  if (series.length < 2) return 0;
  const last = series[series.length - 1];
  let n = 0;
  for (let i = series.length - 2; i >= 0; i--) {
    if (Math.abs(series[i] - last) < 1e-9) n++;
    else break;
  }
  return n;
}

const GROUP_H = 16;

type SortKey = "e1Gap4wChange" | "unpricedGap" | "e1Gap" | "relReturn1m" | "relReturn3m" | "hedgeEff" | "residualSharePct";

/** A signed centred bar (‑range..+range) for the breadth-gap / hedge columns.
 *  `floor` draws faint ticks at +-floor — the name-equivalent noise floor, so
 *  the bar is read against what a single analyst changing their mind is worth. */
function GapBar({ value, range, w = 46, floor }: { value: number | null; range: number; w?: number; floor?: number | null }) {
  const half = w / 2;
  const v = value === null || !Number.isFinite(value) ? 0 : Math.max(-range, Math.min(range, value));
  const len = (Math.abs(v) / range) * half;
  const floorPx = floor != null && Number.isFinite(floor) ? (Math.min(range, floor) / range) * half : null;
  return (
    <span style={{ position: "relative", display: "inline-block", width: w, height: 8, verticalAlign: "middle" }}>
      <span style={{ position: "absolute", left: half, top: 0, bottom: 0, width: 1, background: "var(--chrome-border)" }} />
      {floorPx !== null &&
        [half + floorPx, half - floorPx].map((x, k) => (
          <span key={k} style={{ position: "absolute", left: x, top: 0, bottom: 0, width: 1, background: "var(--text-muted)", opacity: 0.5 }} />
        ))}
      {value !== null && Number.isFinite(value) && (
        <span
          style={{
            position: "absolute",
            top: 2,
            height: 4,
            width: len,
            background: v >= 0 ? "var(--color-positive)" : "var(--color-negative)",
            [v >= 0 ? "left" : "right"]: half,
          }}
        />
      )}
    </span>
  );
}

/** A 0..1 hedge-efficiency bar (left-anchored); red below the min. */
function HedgeBar({ value, w = 40 }: { value: number | null; w?: number }) {
  if (value === null || !Number.isFinite(value)) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const weak = value < PAIR_THRESHOLDS.minHedgeEff;
  const len = Math.max(0, Math.min(1, value)) * w;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ position: "relative", display: "inline-block", width: w, height: 8, background: "var(--bg-base)" }}>
        <span style={{ position: "absolute", left: 0, top: 2, height: 4, width: len, background: weak ? "var(--color-negative)" : "var(--color-positive)" }} />
      </span>
      <span className="bb-num" style={{ fontSize: 9, color: weak ? "var(--color-negative)" : "var(--text-secondary)" }}>{value.toFixed(2)}</span>
    </span>
  );
}

/** A valuation-percentile track P0..P100 with a marker; green cheap, red rich. */
function ValTrack({ pctile, w = 46 }: { pctile: number | null; w?: number }) {
  if (pctile === null || !Number.isFinite(pctile)) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const x = Math.max(0, Math.min(100, pctile)) / 100 * w;
  const color = pctile >= 90 ? "var(--color-negative)" : pctile <= 10 ? "var(--color-positive)" : "var(--text-secondary)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ position: "relative", display: "inline-block", width: w, height: 8, background: "linear-gradient(90deg, rgba(47,143,69,0.25), rgba(120,120,120,0.15), rgba(168,58,63,0.25))" }}>
        <span style={{ position: "absolute", left: Math.max(0, x - 1), top: 0, bottom: 0, width: 2, background: color }} />
      </span>
      <span className="bb-num" style={{ fontSize: 9, color }}>P{pctile.toFixed(0)}</span>
    </span>
  );
}

function Th({
  id,
  label,
  right,
  sortKey,
  activeSort,
  dir,
  onSort,
}: {
  id?: PairMetricId;
  label: string;
  right?: boolean;
  sortKey?: SortKey;
  activeSort?: SortKey;
  dir?: "asc" | "desc";
  onSort?: (k: SortKey) => void;
}) {
  const isActive = sortKey && sortKey === activeSort;
  return (
    <th
      onClick={sortKey && onSort ? () => onSort(sortKey) : undefined}
      style={{
        textAlign: right ? "right" : "left",
        padding: "4px 6px",
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        color: isActive ? "var(--color-accent)" : "var(--text-muted)",
        borderBottom: "1px solid var(--chrome-border)",
        whiteSpace: "nowrap",
        position: "sticky",
        top: GROUP_H,
        background: "var(--bg-surface)",
        cursor: sortKey ? "pointer" : "default",
      }}
    >
      {id ? <PairMetricTip id={id}>{label}</PairMetricTip> : label}
      {isActive ? (dir === "asc" ? " ▲" : " ▼") : sortKey ? " ⇅" : ""}
    </th>
  );
}

function GroupTh({ label, span }: { label: string; span: number }) {
  return (
    <th
      colSpan={span}
      style={{
        height: GROUP_H,
        padding: "0 6px",
        fontSize: 8,
        fontWeight: 700,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        textAlign: "center",
        color: "var(--text-secondary)",
        background: "var(--bb-chrome)",
        borderLeft: "1px solid var(--chrome-border)",
        borderBottom: "1px solid var(--chrome-border)",
        whiteSpace: "nowrap",
        position: "sticky",
        top: 0,
        zIndex: 1,
      }}
    >
      {label}
    </th>
  );
}

function flagTone(id: string): "positive" | "negative" | "warning" | "muted" {
  if (id === "UNPRICED" || id === "NEW") return "positive";
  if (id === "PRICED" || id === "CROWDED_LONG" || id === "SHORT_LEG_OWNED" || id === "LOW_HEDGE_EFF") return "negative";
  if (id === "FACTOR_BET" || id === "ENGINES_DISAGREE" || id === "NARROWING" || id === "THIN_GAP") return "warning";
  return "muted";
}

const FILTERS = [
  { v: "ALL", label: "All" },
  { v: "NEW", label: "New this week" },
  { v: "UNPRICED", label: "Unpriced only" },
] as const;
type FilterKind = (typeof FILTERS)[number]["v"];

function toCsv(rows: PairRowPayload[]): string {
  const head = [
    "long",
    "short",
    "sector",
    "hedgeEff",
    "e1Gap",
    "e1Gap4wChange",
    "e2Gap",
    "e2Gap4wChange",
    "e3NetBuyerGap",
    "relReturn1m",
    "relReturn3m",
    "unpricedGap",
    "valRatioPctile",
    "priceRatioZ",
    "residualSharePct",
    "topFactor",
    "topFactorLoading",
    "topFactorVarPct",
    "crowdingLong",
    "crowdingShort",
    "crowdBreadthLong",
    "crowdBreadthShort",
    "ewMinusCw1m",
    "flags",
  ];
  const line = (r: PairRowPayload) =>
    [
      r.longKey,
      r.shortKey,
      r.crossSector ? `${r.longSector} x ${r.shortSector}` : r.longSector ?? "",
      r.hedgeEff,
      r.e1Gap,
      r.e1Gap4wChange,
      r.e2Gap,
      r.e2Gap4wChange,
      r.e3NetBuyerGap,
      r.relReturn1m,
      r.relReturn3m,
      r.unpricedGap,
      r.valRatioPctile,
      r.priceRatioZ,
      r.residualSharePct,
      r.topFactor ?? "",
      r.topFactorLoading,
      r.topFactorVarPct,
      r.crowdingLong,
      r.crowdingShort,
      r.crowdBreadthLong,
      r.crowdBreadthShort,
      r.ewMinusCw1m,
      r.flags.join("|"),
    ]
      .map((v) => (v === null || v === undefined ? "" : String(v)))
      .join(",");
  return [head.join(","), ...rows.map(line)].join("\n");
}

export function PairRankTable({
  rows,
  snapshotDate,
  onSelect,
  hideThinGaps: hideThinGapsProp,
  totalPairs,
  passHedgeEff,
  scopeLabel,
}: {
  rows: PairRowPayload[];
  snapshotDate?: string;
  onSelect?: (r: PairRowPayload) => void;
  /** When provided, the thin-gap filter is controlled by the parent (one
   *  control governs both this table and the divergence scatter) and the local
   *  checkbox is hidden. */
  hideThinGaps?: boolean;
  /** Upstream counts (PairUniverseWeek) so the footer can show the whole
   *  filter chain in one place rather than only the tail. */
  totalPairs?: number;
  passHedgeEff?: number;
  scopeLabel?: string;
}) {
  const [filter, setFilter] = useState<FilterKind>("ALL");
  const [hideFactorBets, setHideFactorBets] = useState(false);
  const [hideThinGapsLocal, setHideThinGapsLocal] = useState(true);
  const thinControlled = hideThinGapsProp !== undefined;
  const hideThinGaps = thinControlled ? hideThinGapsProp : hideThinGapsLocal;
  const [capLegs, setCapLegs] = useState(true);
  const [showOverflow, setShowOverflow] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("e1Gap4wChange");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const onSort = (k: SortKey) => {
    if (k === sortKey) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setDir("desc");
    }
  };

  const filtered = useMemo(() => {
    let out = rows.filter((r) => {
      if (filter === "NEW" && !r.flags.includes("NEW")) return false;
      if (filter === "UNPRICED" && !r.flags.includes("UNPRICED")) return false;
      if (hideFactorBets && r.flags.includes("FACTOR_BET")) return false;
      if (hideThinGaps && r.thinGap) return false;
      return true;
    });
    out = [...out].sort((a, b) => {
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      return dir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return out;
  }, [rows, filter, hideFactorBets, hideThinGaps, sortKey, dir]);

  // Per-leg display cap — collapses "one story told many times" without
  // dropping anything from the data (CSV still exports the full filtered set).
  const capped = useMemo(
    () => capByLeg(filtered, capLegs ? PAIR_THRESHOLDS.legDisplayCap : 0),
    [filtered, capLegs],
  );
  const overflowByLeg = useMemo(
    () =>
      [...capped.hiddenByLeg.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([leg, n]) => `${leg} x${n}`)
        .join(", "),
    [capped.hiddenByLeg],
  );

  const exportCsv = () => {
    const blob = new Blob([toCsv(filtered)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pair-rank-${snapshotDate ?? "latest"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (rows.length === 0) {
    return <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 12 }}>No pairs match the current filters.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Filter chips */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "4px 8px", borderBottom: "1px solid var(--chrome-border)" }}>
        <span style={{ display: "inline-flex", gap: 3 }}>
          {FILTERS.map((f) => {
            const active = f.v === filter;
            return (
              <button
                key={f.v}
                onClick={() => setFilter(f.v)}
                style={{
                  fontSize: 8.5,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                  textTransform: "uppercase",
                  padding: "1px 7px",
                  cursor: "pointer",
                  color: active ? "#000" : "var(--text-secondary)",
                  background: active ? "var(--color-accent)" : "var(--bg-base)",
                  border: `1px solid ${active ? "var(--color-accent)" : "var(--chrome-border)"}`,
                }}
              >
                {f.label}
              </button>
            );
          })}
        </span>
        <label style={{ fontSize: 8.5, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={hideFactorBets} onChange={(e) => setHideFactorBets(e.target.checked)} />
          hide factor bets
        </label>
        {!thinControlled && (
          <label style={{ fontSize: 8.5, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input type="checkbox" checked={hideThinGaps} onChange={(e) => setHideThinGapsLocal(e.target.checked)} />
            hide thin gaps
          </label>
        )}
        <label style={{ fontSize: 8.5, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={capLegs} onChange={(e) => setCapLegs(e.target.checked)} />
          cap {PAIR_THRESHOLDS.legDisplayCap}/leg
        </label>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 9, color: "var(--text-muted)" }} title="The full filter chain, in order, so no stage's drop is hidden.">
          {[
            totalPairs !== undefined ? `${totalPairs} pairs` : null,
            passHedgeEff !== undefined ? `${passHedgeEff} pass hedge-eff` : null,
            `${rows.length}${scopeLabel ? ` ${scopeLabel}` : " in scope"}`,
            `${filtered.length} after filters`,
            `${capped.shown.length} shown (cap ${PAIR_THRESHOLDS.legDisplayCap}/leg)`,
          ]
            .filter(Boolean)
            .join(" → ")}
          {snapshotDate ? ` · week of ${snapshotDate}` : ""}
        </span>
        <button
          onClick={exportCsv}
          style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", padding: "1px 7px", cursor: "pointer", color: "var(--text-secondary)", background: "var(--bg-base)", border: "1px solid var(--chrome-border)" }}
        >
          ↓ CSV
        </button>
      </div>

      <div style={{ overflow: "auto", border: "1px solid var(--chrome-border)", maxHeight: 560 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
          <thead>
            <tr>
              <GroupTh label="#" span={1} />
              <GroupTh label="The pair" span={2} />
              <GroupTh label="Hedge" span={1} />
              <GroupTh label="E1 · analyst revisions (◇=names)" span={2} />
              <GroupTh label="E2 · inflection" span={2} />
              <GroupTh label="13F" span={1} />
              <GroupTh label="Last 13 weeks" span={2} />
              <GroupTh label="Share-price performance" span={2} />
              <GroupTh label="Valuation" span={2} />
              <GroupTh label="Engine 4 · factor model" span={4} />
              <GroupTh label="Crowding" span={3} />
              <GroupTh label="Read" span={1} />
            </tr>
            <tr>
              <Th label="#" right />
              <Th label="Long ▸ short" />
              <Th label="Sector" />
              <Th id="hedgeEff" label="Hedge eff." sortKey="hedgeEff" activeSort={sortKey} dir={dir} onSort={onSort} />
              <Th id="e1Gap" label="Gap" right sortKey="e1Gap" activeSort={sortKey} dir={dir} onSort={onSort} />
              <Th id="e1Gap4wChange" label="Δ4w" right sortKey="e1Gap4wChange" activeSort={sortKey} dir={dir} onSort={onSort} />
              <Th id="e2Gap" label="Gap" right />
              <Th id="e2Gap4wChange" label="Δ4w" right />
              <Th id="e3NetBuyerGap" label="Net buy L−S" right />
              <Th id="signalSparkline" label="Signal gap" />
              <Th id="priceRatioSparkline" label="Price ratio" />
              <Th id="relReturn1m" label="Rel 1m" right sortKey="relReturn1m" activeSort={sortKey} dir={dir} onSort={onSort} />
              <Th id="relReturn3m" label="Rel 3m" right sortKey="relReturn3m" activeSort={sortKey} dir={dir} onSort={onSort} />
              <Th id="unpricedGap" label="Unpriced σ" right sortKey="unpricedGap" activeSort={sortKey} dir={dir} onSort={onSort} />
              <Th id="valRatioPctile" label="Val vs hist" />
              <Th id="priceRatioZ" label="Ratio z" right />
              <Th id="residualShare" label="Resid%" right sortKey="residualSharePct" activeSort={sortKey} dir={dir} onSort={onSort} />
              <Th id="topFactor" label="Top factor" />
              <Th id="topFactorVarPct" label="σ%" right />
              <Th id="crowding" label="Funds L/S" right />
              <Th id="crowdBreadth" label="Breadth L/S" right />
              <Th id="ewMinusCw1m" label="EW−CW" right />
              <Th label="Flags" />
            </tr>
          </thead>
          <tbody>
            {(() => {
              const renderRow = (r: PairRowPayload, i: number, dimmed: boolean) => (
                <tr
                  key={`${r.longKey}|${r.shortKey}`}
                  onClick={() => onSelect?.(r)}
                  style={{ cursor: onSelect ? "pointer" : "default", background: i % 2 ? "var(--bg-base)" : "transparent", opacity: dimmed ? 0.5 : 1 }}
                >
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: "var(--text-muted)" }}>{i + 1}</td>
                  <td style={{ padding: "3px 6px", whiteSpace: "nowrap", lineHeight: 1.25 }}>
                    <div>
                      <span style={{ fontWeight: 700, color: "var(--color-positive)" }}>{r.longKey}</span>
                      <PairMetricTip
                        id="e1Breadth"
                        label={`${r.longKey} (long leg)`}
                        arithmetic={`${r.longNameCount} names · one name flipping = 200/${r.longNameCount} = ${nameStepPp(r.longNameCount)?.toFixed(0) ?? "—"}pp of breadth`}
                      >
                        <span className="bb-num" style={{ color: "var(--text-muted)", marginLeft: 4, fontSize: 8.5 }}>n={r.longNameCount}</span>
                      </PairMetricTip>
                      {r.orientationFlipped && (
                        <span title="Orientation flipped this week" style={{ marginLeft: 4, fontSize: 8, color: "var(--color-accent)" }}>⇄</span>
                      )}
                    </div>
                    <div>
                      <span style={{ fontWeight: 700, color: "var(--color-negative)" }}>{r.shortKey}</span>
                      <PairMetricTip
                        id="e1Breadth"
                        label={`${r.shortKey} (short leg)`}
                        arithmetic={`${r.shortNameCount} names · one name flipping = 200/${r.shortNameCount} = ${nameStepPp(r.shortNameCount)?.toFixed(0) ?? "—"}pp of breadth`}
                      >
                        <span className="bb-num" style={{ color: "var(--text-muted)", marginLeft: 4, fontSize: 8.5 }}>n={r.shortNameCount}</span>
                      </PairMetricTip>
                    </div>
                  </td>
                  <td style={{ padding: "3px 6px", whiteSpace: "nowrap", color: "var(--text-secondary)", fontSize: 9.5 }}>
                    {r.crossSector ? `${r.longSector ?? "—"} × ${r.shortSector ?? "—"}` : r.longSector ?? "—"}
                  </td>
                  <td style={{ padding: "3px 6px", textAlign: "right" }}><HedgeBar value={r.hedgeEff} /></td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: signColor(r.e1Gap) }}>
                    {(() => {
                      const minN = Math.min(r.longNameCount, r.shortNameCount);
                      const step = nameStepPp(minN);
                      const nameEquiv =
                        r.e1Gap !== null && Number.isFinite(r.e1Gap) && step ? Math.abs(r.e1Gap) / step : null;
                      return (
                        <PairMetricTip
                          id="e1Gap"
                          arithmetic={`floor = max(8, 200 / min(${r.longNameCount}, ${r.shortNameCount})) = ${r.gapNoiseFloorPp.toFixed(0)}pp · gap ${formatGapPp(r.e1Gap)} ≈ ${nameEquiv?.toFixed(1) ?? "—"} names`}
                        >
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "flex-end", borderBottom: "none" }}>
                            <GapBar value={r.e1Gap} range={80} floor={r.gapNoiseFloorPp} />
                            {formatGapPp(r.e1Gap)}
                            {nameEquiv !== null && (
                              <span style={{ color: "var(--text-muted)", fontSize: 8, marginLeft: 1 }} title="name-equivalents (gap ÷ one-name step)">◇{nameEquiv.toFixed(1)}</span>
                            )}
                          </span>
                        </PairMetricTip>
                      );
                    })()}
                  </td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: signColor(r.e1Gap4wChange) }}>
                    {pp(r.e1Gap4wChange)}
                    {arrow(r.e1Gap4wChange)}
                  </td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: signColor(r.e2Gap) }}>{pp(r.e2Gap)}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: signColor(r.e2Gap4wChange) }}>
                    {(() => {
                      const flat = trailingFlatWeeks(r.e2GapSeries);
                      const stale = r.e2Gap4wChange !== null && Math.abs(r.e2Gap4wChange) < 1e-9 && flat >= 4;
                      if (stale) {
                        return (
                          <PairMetricTip
                            id="e2Gap4wChange"
                            label="no fundamentals refresh"
                            arithmetic={`Engine 2 updates on a quarterly fundamentals cadence — inflection breadth has been unchanged for ${flat} weeks, so a 4-week diff is 0 until the next refresh (not "measured, no change").`}
                          >
                            <span style={{ color: "var(--text-muted)", fontSize: 8.5, letterSpacing: 0.2 }}>↺ {flat}w</span>
                          </PairMetricTip>
                        );
                      }
                      return (
                        <>
                          {pp(r.e2Gap4wChange)}
                          {arrow(r.e2Gap4wChange)}
                        </>
                      );
                    })()}
                  </td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: signColor(r.e3NetBuyerGap) }}>{pp(r.e3NetBuyerGap)}</td>
                  <td style={{ padding: "3px 6px" }}>
                    <Sparkline values={r.e1GapSeries} clamp={Math.max(8, ...r.e1GapSeries.map((v) => Math.abs(v)))} />
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    {(() => {
                      // The stored series is the price-RATIO LEVEL (long/short); the Sparkline
                      // plots against the zero midline, so a level far from 0 saturates the
                      // clamp and renders flat. Rebase to % change off the first finite point
                      // so each row is scaled to its OWN move — the read the column is for.
                      const s = r.priceRatioSeries;
                      const base = s.find((v) => Number.isFinite(v) && v !== 0);
                      const reb = base != null ? s.map((v) => (Number.isFinite(v) ? v / base - 1 : v)) : s;
                      const clamp = Math.max(0.005, ...reb.map((v) => (Number.isFinite(v) ? Math.abs(v) : 0)));
                      // Color by the sign of the net move over the window (last rebased
                      // point == cumulative % change off the base), so a widening vs
                      // narrowing ratio reads at a glance instead of a neutral gray.
                      const net = [...reb].reverse().find((v) => Number.isFinite(v)) ?? 0;
                      return <Sparkline values={reb} color={signColor(net)} clamp={clamp} />;
                    })()}
                  </td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: signColor(r.relReturn1m) }}>{pct(r.relReturn1m)}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: signColor(r.relReturn3m) }}>{pct(r.relReturn3m)}</td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", fontWeight: 700, color: signColor(r.unpricedGap) }}>
                    {r.unpricedGap === null ? "—" : r.unpricedGap.toFixed(2)}
                    {!r.unpricedGapCalibrated && r.unpricedGap !== null && (
                      <span title={`Uncalibrated — only ${r.ownObsWeeks} of ${PAIR_THRESHOLDS.calibrationMinWeeks} own weeks`} style={{ color: "var(--text-muted)" }}>*</span>
                    )}
                    {r.unpricedGapDriver && <span style={{ marginLeft: 3, fontSize: 8, color: "var(--text-muted)" }}>{r.unpricedGapDriver}</span>}
                    {(() => {
                      // The σ column is a z-difference over BOTH engines; the UNPRICED
                      // flag is a raw-pp rule on E1 only. A high σ can therefore be
                      // unflagged. State the disqualifying reason inline so the two
                      // definitions sharing the word "unpriced" don't read as a bug.
                      if (r.unpricedGap === null || Math.abs(r.unpricedGap) < 1 || r.flags.includes("UNPRICED")) return null;
                      const e1Flat = !(r.e1Gap4wChange !== null && r.e1Gap4wChange > PAIR_THRESHOLDS.unpricedGapPp);
                      const priced = r.relReturn1m !== null && Math.abs(r.relReturn1m) > PAIR_THRESHOLDS.unpricedRelBand;
                      const why = e1Flat ? "E1 flat" : priced ? "priced" : "—";
                      return (
                        <span title={e1Flat ? "E1 4-week gap change below the unpriced threshold — the σ is E2-driven" : priced ? "price ratio already moved beyond the flat band" : ""} style={{ marginLeft: 3, fontSize: 8, color: "var(--text-muted)", fontStyle: "italic" }}>{why}</span>
                      );
                    })()}
                  </td>
                  <td style={{ padding: "3px 6px" }}><ValTrack pctile={r.valRatioPctile} /></td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: "var(--text-secondary)" }}>
                    {r.priceRatioZ === null ? "—" : r.priceRatioZ.toFixed(2)}
                  </td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: r.residualSharePct !== null && r.residualSharePct < PAIR_THRESHOLDS.factorBetResidualPct ? "var(--color-negative)" : "var(--text-secondary)" }}>
                    {r.residualSharePct === null ? "—" : `${r.residualSharePct.toFixed(0)}%`}
                  </td>
                  <td style={{ padding: "3px 6px", whiteSpace: "nowrap", color: "var(--text-secondary)" }}>
                    {r.topFactor ?? "—"}
                    {r.topFactorLoading !== null && (
                      <span className="bb-num" style={{ marginLeft: 3, fontSize: 9, color: "var(--text-muted)" }}>{r.topFactorLoading.toFixed(2)}</span>
                    )}
                  </td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: "var(--text-muted)" }}>
                    {r.topFactorVarPct === null ? "—" : `${r.topFactorVarPct.toFixed(0)}%`}
                  </td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: "var(--text-secondary)" }}>
                    {r.crowdingLong === null ? "—" : `${r.crowdingLong.toFixed(0)}%`}/{r.crowdingShort === null ? "—" : `${r.crowdingShort.toFixed(0)}%`}
                  </td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: "var(--text-secondary)" }}>
                    {r.crowdBreadthLong === null ? "—" : `${r.crowdBreadthLong.toFixed(0)}%`}/{r.crowdBreadthShort === null ? "—" : `${r.crowdBreadthShort.toFixed(0)}%`}
                  </td>
                  <td className="bb-num" style={{ padding: "3px 6px", textAlign: "right", color: signColor(r.ewMinusCw1m) }}>{pct(r.ewMinusCw1m)}</td>
                  <td style={{ padding: "3px 6px" }}>
                    <span style={{ display: "inline-flex", gap: 3, flexWrap: "wrap" }}>
                      {(r.thinGap && !r.flags.includes("THIN_GAP") ? [...r.flags, "THIN_GAP"] : r.flags).map((f) => (
                        <Tag key={f} label={pairMetric(`flag.${f}` as PairMetricId).label || f} tone={flagTone(f)} title={pairMetric(`flag.${f}` as PairMetricId).short_def} />
                      ))}
                    </span>
                  </td>
                </tr>
              );
              const dividerRow = capped.hidden.length > 0 && (
                <tr key="overflow-divider" style={{ background: "var(--bb-chrome)" }}>
                  <td colSpan={23} style={{ padding: "4px 8px", fontSize: 9, color: "var(--text-muted)", borderTop: "1px solid var(--chrome-border)" }}>
                    {capped.hidden.length} pairs hidden by the {PAIR_THRESHOLDS.legDisplayCap}-per-leg cap{overflowByLeg ? ` (${overflowByLeg})` : ""} —{" "}
                    <button
                      onClick={() => setShowOverflow((v) => !v)}
                      style={{ background: "none", border: "none", color: "var(--color-accent)", cursor: "pointer", fontSize: 9, textDecoration: "underline", padding: 0 }}
                    >
                      {showOverflow ? "collapse" : "show all"}
                    </button>
                  </td>
                </tr>
              );
              return (
                <>
                  {capped.shown.map((r, i) => renderRow(r, i, false))}
                  {dividerRow}
                  {showOverflow && capped.hidden.map((r, i) => renderRow(r, capped.shown.length + i, true))}
                </>
              );
            })()}
          </tbody>
        </table>
      </div>
    </div>
  );
}
