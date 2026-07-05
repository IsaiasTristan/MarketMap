"use client";
/**
 * IDEA QUEUE — the rebuilt Master Rank. Divergence scatter on top, table
 * sorted by |gap score| below. The ALL NAMES toggle removes the gap filter and
 * sorts by composite — that is the old Master Rank view. Heat only on decision
 * columns (rev z, gap); context columns stay flat.
 */
import { useMemo, useState } from "react";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { PanelState } from "@/components/analysis/ui/PanelState";
import { useRevision } from "./useRevision";
import { MetricTip } from "./MetricTip";
import { DivergenceScatter, type ScatterPoint } from "./DivergenceScatter";
import { SideChip, StreakStrip, TagChip, fmtZ, heatZ } from "./researchUi";
import type { RevMetricId } from "@/lib/revision/metric-registry";

interface QueueRow {
  ticker: string;
  companyName: string;
  sector: string | null;
  subsector: string | null;
  composite: number | null;
  rank: number | null;
  subsectorDecile: number | null;
  sectorDecile: number | null;
  newArrival: boolean;
  nextEarningsDate: string | null;
  gapScore: number | null;
  px4wZ: number | null;
  composite4wZ: number | null;
  composite4wWeeksUsed: number | null;
  streak: { len: number; sign: number; source: string } | null;
  streakHistory: Array<-1 | 0 | 1> | null;
  dispersionTrend: string | null;
  side: string | null;
  setupTags: string[] | null;
  daysToEarnings: number | null;
}

interface QueuePayload {
  snapshotDate: string;
  count: number;
  effectiveWindow?: { legAWeeks: number; composite4wWindow: number; streakSource: string };
  rows: QueueRow[];
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "3px 6px",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 0.5,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "3px 6px",
  fontSize: 11,
  borderTop: "1px solid var(--chrome-border)",
  whiteSpace: "nowrap",
};

function Th({ id, children, style }: { id: RevMetricId; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th style={{ ...th, ...style }}>
      <MetricTip id={id}>{children}</MetricTip>
    </th>
  );
}

function DispGlyph({ trend }: { trend: string | null }) {
  if (trend === "NARROWING") return <span style={{ color: "var(--color-positive)" }}>▼ NARR</span>;
  if (trend === "WIDENING") return <span style={{ color: "var(--color-warning)" }}>▲ WIDE</span>;
  if (trend === "FLAT") return <span style={{ color: "var(--text-muted)" }}>— FLAT</span>;
  return <span style={{ color: "var(--text-muted)" }}>·</span>;
}

export function IdeaQueuePanel({
  focusTicker,
  onSelectTicker,
}: {
  focusTicker?: string | null;
  onSelectTicker: (t: string) => void;
}) {
  const { data, state, error } = useRevision<QueuePayload>(
    ["research-queue-v2"],
    "/api/analysis/research/queue?limit=3000",
  );
  const [showL, setShowL] = useState(true);
  const [showS, setShowS] = useState(true);
  const [showW, setShowW] = useState(true);
  const [minGap, setMinGap] = useState(0.5);
  const [sector, setSector] = useState("");
  const [subsector, setSubsector] = useState("");
  const [onlyNew, setOnlyNew] = useState(false);
  const [query, setQuery] = useState(focusTicker ?? "");
  const [allNames, setAllNames] = useState(false);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const sectors = useMemo(() => [...new Set(rows.map((r) => r.sector).filter(Boolean))].sort() as string[], [rows]);
  const subsectors = useMemo(() => {
    const pool = sector ? rows.filter((r) => r.sector === sector) : rows;
    return [...new Set(pool.map((r) => r.subsector).filter(Boolean))].sort() as string[];
  }, [rows, sector]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let out = rows.filter((r) => {
      if (q && !r.ticker.includes(q) && !r.companyName.toUpperCase().includes(q)) return false;
      if (sector && r.sector !== sector) return false;
      if (subsector && r.subsector !== subsector) return false;
      if (onlyNew && !r.newArrival && !(r.setupTags ?? []).includes("NEW")) return false;
      const sideKey = r.side === "LONG" ? "L" : r.side === "SHORT" ? "S" : "W";
      if (sideKey === "L" && !showL) return false;
      if (sideKey === "S" && !showS) return false;
      if (sideKey === "W" && !showW) return false;
      if (!allNames && (r.gapScore === null || Math.abs(r.gapScore) < minGap)) return false;
      return true;
    });
    out = out.sort(
      allNames
        ? (a, b) => (b.composite ?? -Infinity) - (a.composite ?? -Infinity)
        : (a, b) => Math.abs(b.gapScore ?? 0) - Math.abs(a.gapScore ?? 0),
    );
    return out;
  }, [rows, query, sector, subsector, onlyNew, showL, showS, showW, allNames, minGap]);

  const points: ScatterPoint[] = useMemo(
    () =>
      rows
        .filter((r) => r.composite4wZ !== null && r.px4wZ !== null)
        .map((r) => ({
          ticker: r.ticker,
          revZ: r.composite4wZ!,
          pxZ: r.px4wZ!,
          gap: r.gapScore ?? 0,
          side: r.side,
        })),
    [rows],
  );

  const control: React.CSSProperties = {
    background: "var(--bg-surface)",
    border: "1px solid var(--chrome-border)",
    color: "var(--text-primary)",
    fontSize: 10,
    padding: "2px 5px",
  };
  const checkbox = (label: string, checked: boolean, set: (v: boolean) => void) => (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--text-secondary)", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} /> {label}
    </label>
  );

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <ChartCard
            title="Rev / price divergence"
            subtitle="x = 4W REV COMPOSITE Z · y = 4W REL PX Z · distance from diagonal = gap · click a point to filter"
            compact={false}
            style={{ overflow: "visible" }}
          >
            <DivergenceScatter
              points={points}
              selected={query.trim().toUpperCase() || null}
              onPick={(t) => setQuery(t ?? "")}
            />
          </ChartCard>

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            {checkbox("L", showL, setShowL)}
            {checkbox("S", showS, setShowS)}
            {checkbox("W", showW, setShowW)}
            <label style={{ fontSize: 10, color: "var(--text-secondary)" }}>
              min |gap|{" "}
              <input
                type="number"
                step={0.25}
                min={0}
                value={minGap}
                disabled={allNames}
                onChange={(e) => setMinGap(Number(e.target.value))}
                style={{ ...control, width: 52, opacity: allNames ? 0.4 : 1 }}
              />
            </label>
            <select value={sector} onChange={(e) => { setSector(e.target.value); setSubsector(""); }} style={control}>
              <option value="">All sectors</option>
              {sectors.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select value={subsector} onChange={(e) => setSubsector(e.target.value)} style={control}>
              <option value="">All subsectors</option>
              {subsectors.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            {checkbox("New only", onlyNew, setOnlyNew)}
            <input
              placeholder="Search ticker / name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ ...control, width: 150 }}
            />
            {checkbox("ALL NAMES", allNames, setAllNames)}
            <span style={{ fontSize: 9, color: "var(--text-muted)" }}>
              {filtered.length} names · as of {data.snapshotDate}
              {data.effectiveWindow ? ` · rev(4w) uses ${Math.min(data.effectiveWindow.legAWeeks, data.effectiveWindow.composite4wWindow)}w of ${data.effectiveWindow.composite4wWindow}w` : ""}
            </span>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="bb-table" style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <Th id="rank">#</Th>
                  <th style={th}>Ticker</th>
                  <th style={th}>Setup</th>
                  <Th id="composite4wZ">Rev z</Th>
                  <Th id="px4wZ">Px z</Th>
                  <Th id="gapScore">Gap</Th>
                  <Th id="streak">6w streak</Th>
                  <Th id="dispTrend">Disp</Th>
                  <Th id="nextEr">Next ER</Th>
                  <Th id="side">Side</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 400).map((r, i) => (
                  <tr key={r.ticker}>
                    <td className="bb-num" style={{ ...td, color: "var(--text-muted)" }}>{i + 1}</td>
                    <td style={td}>
                      <button
                        type="button"
                        onClick={() => onSelectTicker(r.ticker)}
                        style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--color-accent)", fontWeight: 700, font: "inherit" }}
                      >
                        {r.ticker}
                      </button>
                      {r.newArrival && (
                        <span style={{ fontSize: 8, fontWeight: 700, color: "#000", background: "var(--color-positive)", padding: "0 3px", marginLeft: 4 }}>
                          NEW
                        </span>
                      )}
                    </td>
                    <td style={td}>{(r.setupTags ?? []).map((tag) => <TagChip key={tag} tag={tag} />)}</td>
                    <td className="bb-num" style={{ ...td, color: heatZ(r.composite4wZ ?? null, 1.5) }}>
                      {fmtZ(r.composite4wZ)}
                    </td>
                    <td className="bb-num" style={{ ...td, color: "var(--text-secondary)" }}>{fmtZ(r.px4wZ)}</td>
                    <td className="bb-num" style={{ ...td, fontWeight: 700, color: heatZ(r.gapScore ?? null, 2) }}>
                      {fmtZ(r.gapScore)}
                    </td>
                    <td style={td}>
                      <StreakStrip history={r.streakHistory ?? []} source={r.streak?.source} />
                    </td>
                    <td style={{ ...td, fontSize: 9 }}>
                      <DispGlyph trend={r.dispersionTrend} />
                    </td>
                    <td className="bb-num" style={{ ...td, color: (r.daysToEarnings ?? 99) <= 7 ? "#ffd24a" : "var(--text-muted)" }}>
                      {r.nextEarningsDate ?? "—"}
                    </td>
                    <td style={td}>
                      <SideChip side={r.side} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)" }}>
                NO NAMES PASS THE CURRENT FILTERS{allNames ? "" : " — LOWER MIN |GAP| OR TOGGLE ALL NAMES"}
              </div>
            )}
          </div>
        </div>
      )}
    </PanelState>
  );
}
