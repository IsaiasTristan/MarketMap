"use client";

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { heatSignedBloomberg, heatPercentileBloomberg } from "@/components/analysis/ui/heat";
import { sectorColor, subThemeColor } from "@/lib/market-map/sector-colors";
import { formatMetricValue } from "@/lib/format";
import type { Horizon } from "@/domain/entities/horizons";
import { BOX_REGISTRY, flatKey, type BoxKey } from "@/lib/fundamental/boxes";
import type { DiscoveryRow } from "./types";

const PAGE_SIZE = 100;

/** Performance columns shown left of the Sector column (1D / 5D / 1M / 6M / 1Y). */
const PERF_COLS: Array<{ h: Horizon; label: string }> = [
  { h: "D1", label: "1D" },
  { h: "D5", label: "5D" },
  { h: "M1", label: "1M" },
  { h: "M6", label: "6M" },
  { h: "Y1", label: "1Y" },
];

/** White on dark backgrounds, black on light — mirrors the market map's cell text contrast. */
function pickTextColor(bg: string): string {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(bg);
  if (!m) return "#fff";
  const yiq = (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000;
  return yiq >= 150 ? "#000" : "#fff";
}

/**
 * Fractional-rank percentile of each finite value within its column, so the
 * median maps to 0.5 (neutral gray). Returns a per-ticker map per horizon.
 */
function buildPercentiles(
  rows: DiscoveryRow[],
): Record<Horizon, Map<string, number>> {
  const out = {} as Record<Horizon, Map<string, number>>;
  for (const { h } of PERF_COLS) {
    const vals: Array<{ ticker: string; v: number }> = [];
    for (const r of rows) {
      const v = r.returns?.[h];
      if (v != null && Number.isFinite(v)) vals.push({ ticker: r.ticker, v });
    }
    const map = new Map<string, number>();
    const n = vals.length;
    if (n > 0) {
      const sorted = vals.map((x) => x.v).sort((a, b) => a - b);
      for (const { ticker, v } of vals) {
        let below = 0;
        let equal = 0;
        for (const s of sorted) {
          if (s < v) below += 1;
          else if (s === v) equal += 1;
        }
        map.set(ticker, n === 1 ? 0.5 : (below + 0.5 * equal) / n);
      }
    }
    out[h] = map;
  }
  return out;
}

/**
 * One grid column per box (the multi-box discovery model). The cell shows the
 * box score (mean of the box's component peer z-scores) as a heat bar; clicking
 * a cell opens the composition panel with the box's underlying components.
 */
const BOX_COLS: Array<{ key: BoxKey; label: string; title: string }> =
  BOX_REGISTRY.map((b) => ({
    key: b.key,
    label: b.shortLabel,
    title: `${b.label} — ${b.description} (box score = mean of component peer z-scores). Click for its composition.`,
  }));

/** Compact badge codes for the trap / data-quality flags (full text on hover). */
const FLAG_ABBR: Record<string, { code: string; severe: boolean }> = {
  "HIGH LEVERAGE": { code: "LEV", severe: true },
  "NEGATIVE FCF": { code: "FCF−", severe: true },
  "LOW INTEREST COVERAGE": { code: "IC", severe: true },
  "EQUITY DILUTION": { code: "DIL", severe: false },
  "ESTIMATE COVERAGE LOW": { code: "COV", severe: false },
  "FORECAST DISPERSION HIGH": { code: "DISP", severe: false },
  "MOMENTUM DETERIORATING": { code: "MOM−", severe: false },
  "WORKING CAPITAL BOOST": { code: "WC", severe: false },
  "ONE-QUARTER INFLECTION": { code: "1Q", severe: false },
  "STALE DATA": { code: "STALE", severe: false },
  "POSSIBLE DISTRESS": { code: "DSTR", severe: true },
  "MICROCAP": { code: "μCAP", severe: false },
  "FINANCIAL COMPANY — SPECIAL METHODOLOGY": { code: "FIN", severe: false },
  "INSUFFICIENT DATA": { code: "INSUF", severe: true },
};

type SortKey =
  | "rank"
  | "ticker"
  | "company"
  | "sector"
  | "subsector"
  | "composite"
  | "decile"
  | `box:${BoxKey}`
  | "perf_D1"
  | "perf_D5"
  | "perf_M1"
  | "perf_M6"
  | "perf_Y1";

type SortDir = "asc" | "desc";

const BAR_W = 46;
const BAR_H = 14;
const SPARK_W = 58;
const SPARK_H = 14;

/** Compact bar + sparkline sizing for the inline component breakout columns. */
const EXP_BAR_W = 30;
const EXP_SPARK_W = 36;

/** Sparkline width for the per-box z-over-time spark in the collapsed grid. */
const BOX_SPARK_W = 50;

/** Uniform width for Sector / Subsector / Composite (~the word "Composite"). */
const META_COL_W = 66;

/** Narrow wrapping headers used for the box + component columns when a box is expanded. */
const WRAP_BOX_W = 52; // matches the expanded box cell (a single z-bar)
const WRAP_COMP_W = 80; // matches the component cell (bar + mini sparkline)

/** z-score bar with the z value rendered in white inside the bar track. */
function ZBar({ z, w = BAR_W, h = BAR_H }: { z: number | null; w?: number; h?: number }) {
  if (z === null || !Number.isFinite(z)) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: w,
          height: h,
          background: "var(--bg-surface)",
          color: "var(--text-muted)",
          fontSize: 9,
        }}
      >
        ·
      </span>
    );
  }
  const color = heatSignedBloomberg(z, 2);
  const fillPct = Math.min(100, Math.abs(z) * 35);
  return (
    <span style={{ position: "relative", display: "inline-block", width: w, height: h, background: "var(--bg-surface)", flex: "0 0 auto" }}>
      <span style={{ position: "absolute", top: 0, bottom: 0, left: z < 0 ? 0 : 2, width: `${fillPct}%`, background: color }} />
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontSize: 9,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          pointerEvents: "none",
        }}
      >
        {z.toFixed(2)}
      </span>
    </span>
  );
}

/** Compact inline-SVG sparkline of the underlying 8-quarter metric series. */
function MiniSparkline({ data, color, w = SPARK_W, h = SPARK_H }: { data: number[]; color: string; w?: number; h?: number }) {
  if (!data || data.length < 2) {
    return <span style={{ display: "inline-block", width: w, height: h, flex: "0 0 auto" }} />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 1.5;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * (w - pad * 2) + pad;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block", flex: "0 0 auto" }} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function BoxScoreCell({ z, title }: { z: number | null; title: string }) {
  return (
    <span
      title={`${title}: ${z === null || !Number.isFinite(z) ? "n/a" : z.toFixed(2)}`}
      style={{ display: "inline-flex", alignItems: "center" }}
    >
      <ZBar z={z} />
    </span>
  );
}

/**
 * Collapsed-grid box cell: the box z-bar plus a sparkline of the box z
 * reconstructed point-in-time over the last ~8 quarters. Sparse boxes (< 2
 * finite points, e.g. Forecast Confidence early on) render no line.
 */
function CollapsedBoxCell({
  score,
  history,
  title,
}: {
  score: number | null;
  history: Array<number | null> | undefined;
  title: string;
}) {
  const finite = (history ?? []).filter((v): v is number => v !== null && Number.isFinite(v));
  const color =
    score === null || !Number.isFinite(score) ? "var(--text-muted)" : heatSignedBloomberg(score, 1.5);
  return (
    <span
      title={`${title}: ${score === null || !Number.isFinite(score) ? "n/a" : score.toFixed(2)}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
    >
      <ZBar z={score} />
      {finite.length >= 2 ? (
        <MiniSparkline data={finite} color={color} w={BOX_SPARK_W} />
      ) : (
        <span style={{ display: "inline-block", width: BOX_SPARK_W, height: SPARK_H, flex: "0 0 auto" }} />
      )}
    </span>
  );
}

/** Trap / data-quality flag badges (display-only; never alter the composite in V1). */
function FlagChips({ flags }: { flags: string[] | undefined }) {
  if (!flags || flags.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 3, marginLeft: 4, verticalAlign: "middle" }}>
      {flags.map((f) => {
        const meta = FLAG_ABBR[f] ?? { code: f.slice(0, 5), severe: false };
        return (
          <span
            key={f}
            title={f}
            style={{
              fontSize: 8,
              fontWeight: 700,
              lineHeight: "12px",
              padding: "0 3px",
              color: meta.severe ? "#fff" : "#000",
              background: meta.severe ? "var(--bb-red)" : "var(--color-accent)",
              opacity: 0.9,
              whiteSpace: "nowrap",
            }}
          >
            {meta.code}
          </span>
        );
      })}
    </span>
  );
}

function sortValue(row: DiscoveryRow, key: SortKey): string | number | null {
  switch (key) {
    case "rank":
      return row.rank;
    case "ticker":
      return row.ticker;
    case "company":
      return row.companyName ?? "";
    case "sector":
      return row.sector ?? "";
    case "subsector":
      return row.subsector ?? row.sector ?? "";
    case "composite":
      return row.composite;
    case "decile":
      return row.subsectorDecile ?? row.sectorDecile;
    case "perf_D1":
      return row.returns?.D1 ?? null;
    case "perf_D5":
      return row.returns?.D5 ?? null;
    case "perf_M1":
      return row.returns?.M1 ?? null;
    case "perf_M6":
      return row.returns?.M6 ?? null;
    case "perf_Y1":
      return row.returns?.Y1 ?? null;
    default:
      if (key.startsWith("box:")) return row.boxScores?.[key.slice(4) as BoxKey] ?? null;
      return row.z?.[key] ?? null;
  }
}

function compareRows(a: DiscoveryRow, b: DiscoveryRow, key: SortKey, dir: SortDir): number {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  const aNull = av === null || av === undefined || (typeof av === "number" && !Number.isFinite(av));
  const bNull = bv === null || bv === undefined || (typeof bv === "number" && !Number.isFinite(bv));
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  let cmp = 0;
  if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
  else cmp = String(av).localeCompare(String(bv));
  return dir === "asc" ? cmp : -cmp;
}

/** Diagonally-tilted label shared by every header so columns can stay narrow. */
function WrapLabel({
  children,
  onClick,
  active,
  dir,
  emphasis,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  dir?: SortDir;
  emphasis?: boolean;
}) {
  return (
    <span
      onClick={onClick}
      style={{
        display: "inline-block",
        whiteSpace: "normal",
        cursor: onClick ? "pointer" : "default",
        userSelect: "none",
        lineHeight: "11px",
        fontWeight: emphasis ? 700 : 600,
        color: active ? "var(--color-accent)" : emphasis ? "var(--color-accent)" : "var(--text-muted)",
      }}
    >
      {children}
      {active ? <span style={{ marginLeft: 3, color: "var(--color-accent)", fontSize: 9 }}>{dir === "asc" ? "▲" : "▼"}</span> : null}
    </span>
  );
}

const wrapTh: CSSProperties = {
  padding: "3px 4px",
  verticalAlign: "bottom",
  textAlign: "center",
  whiteSpace: "normal",
  overflowWrap: "break-word",
  wordBreak: "break-word",
  hyphens: "auto",
  lineHeight: "11px",
};

function SortHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = "left",
  title,
  tilt = false,
  frame = false,
  width,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right" | "center";
  title?: string;
  tilt?: boolean;
  frame?: boolean;
  width?: number;
}) {
  const active = activeKey === sortKey;
  // Active box column: top + side rails so the whole column reads as one frame.
  const frameShadow = frame
    ? "inset 1px 0 0 var(--color-accent), inset -1px 0 0 var(--color-accent), inset 0 1px 0 var(--color-accent)"
    : undefined;
  if (tilt) {
    return (
      <th style={{ ...wrapTh, width, boxShadow: frameShadow }} title={title ?? `Sort by ${label}`}>
        <WrapLabel onClick={() => onSort(sortKey)} active={active} dir={dir}>
          {label}
        </WrapLabel>
      </th>
    );
  }
  return (
    <th
      style={{
        padding: "3px 6px",
        textAlign: align,
        verticalAlign: "bottom",
        cursor: "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
        color: active ? "var(--color-accent)" : undefined,
        width,
        boxShadow: frameShadow,
      }}
      title={title ?? `Sort by ${label}`}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {active ? <span style={{ marginLeft: 3, color: "var(--color-accent)", fontSize: 9 }}>{dir === "asc" ? "▲" : "▼"}</span> : null}
    </th>
  );
}

const selectStyle: CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--chrome-border)",
  color: "var(--text-primary)",
  fontSize: 11,
  padding: "2px 6px",
};

export function DiscoveryRankTable({
  rows,
  snapshotDate,
  onSelectTicker,
  sectorFilter,
  subsectorFilter,
  excludeSectorFilter,
  excludeSubsectorFilter,
  onSectorFilterChange,
  onSubsectorFilterChange,
  onExcludeSectorFilterChange,
  onExcludeSubsectorFilterChange,
}: {
  rows: DiscoveryRow[];
  snapshotDate?: string;
  onSelectTicker: (t: string) => void;
  sectorFilter: string | null;
  subsectorFilter: string | null;
  excludeSectorFilter: string | null;
  excludeSubsectorFilter: string | null;
  onSectorFilterChange: (v: string | null) => void;
  onSubsectorFilterChange: (v: string | null) => void;
  onExcludeSectorFilterChange: (v: string | null) => void;
  onExcludeSubsectorFilterChange: (v: string | null) => void;
}) {
  const [onlyNew, setOnlyNew] = useState(false);
  const [hideTraps, setHideTraps] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<SortKey>("composite");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expandedBox, setExpandedBox] = useState<BoxKey | null>(null);
  const expandedDef = expandedBox ? BOX_REGISTRY.find((b) => b.key === expandedBox) ?? null : null;
  const expanded = expandedBox !== null;
  // Headers tilt + the heavy text columns narrow only when a box is expanded
  // (when the appended component columns need the room).
  const companyMax = expanded ? 130 : 220;
  const perfPad = expanded ? "2px 3px" : "2px 6px";
  const toggleBox = (k: BoxKey) => setExpandedBox((prev) => (prev === k ? null : k));

  // Whole-set per-column percentiles (independent of filter/sort/page) so a
  // name's heat is absolute across the full discovery set, like the market map.
  const perfPercentiles = useMemo(() => buildPercentiles(rows), [rows]);

  const sectors = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.sector?.trim()) set.add(r.sector.trim());
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const subsectors = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (sectorFilter && r.sector?.trim() !== sectorFilter) continue;
      const sub = r.subsector?.trim() || r.sector?.trim();
      if (sub) set.add(sub);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows, sectorFilter]);

  const allSubsectors = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const sub = r.subsector?.trim() || r.sector?.trim();
      if (sub) set.add(sub);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return rows.filter((r) => {
      if (onlyNew && !r.newArrival) return false;
      if (hideTraps && r.trapFlag) return false;
      if (sectorFilter && (r.sector?.trim() ?? "") !== sectorFilter) return false;
      if (excludeSectorFilter && (r.sector?.trim() ?? "") === excludeSectorFilter) return false;
      if (subsectorFilter) {
        const sub = r.subsector?.trim() || r.sector?.trim() || "";
        if (sub !== subsectorFilter) return false;
      }
      if (excludeSubsectorFilter) {
        const sub = r.subsector?.trim() || r.sector?.trim() || "";
        if (sub === excludeSubsectorFilter) return false;
      }
      if (q && !r.ticker.includes(q) && !(r.companyName ?? "").toUpperCase().includes(q)) return false;
      return true;
    });
  }, [rows, onlyNew, hideTraps, query, sectorFilter, subsectorFilter, excludeSectorFilter, excludeSubsectorFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => compareRows(a, b, sortKey, sortDir));
    return copy;
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [onlyNew, hideTraps, query, sectorFilter, subsectorFilter, excludeSectorFilter, excludeSubsectorFilter, sortKey, sortDir]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "ticker" || key === "company" || key === "sector" || key === "subsector" ? "asc" : "desc");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, flexWrap: "wrap" }}>
        <span style={{ color: "var(--text-muted)" }}>
          as of {snapshotDate ?? "—"} · {sorted.length} names
          {sorted.length !== rows.length ? ` (of ${rows.length})` : ""}
        </span>
        <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> New arrivals only
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={hideTraps} onChange={(e) => setHideTraps(e.target.checked)} /> Hide trap flags
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <select
            value={sectorFilter ?? ""}
            onChange={(e) => {
              onSectorFilterChange(e.target.value || null);
              onSubsectorFilterChange(null);
            }}
            style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }}
            aria-label="Filter by sector"
          >
            <option value="">All sectors</option>
            {sectors.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={excludeSectorFilter ?? ""}
            onChange={(e) => onExcludeSectorFilterChange(e.target.value || null)}
            style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }}
            aria-label="Exclude sector"
          >
            <option value="">Exclude sector…</option>
            {sectors.map((s) => (
              <option key={s} value={s}>Exclude {s}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <select
            value={subsectorFilter ?? ""}
            onChange={(e) => onSubsectorFilterChange(e.target.value || null)}
            style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }}
            aria-label="Filter by subsector"
            disabled={subsectors.length === 0}
          >
            <option value="">All subsectors</option>
            {subsectors.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={excludeSubsectorFilter ?? ""}
            onChange={(e) => onExcludeSubsectorFilterChange(e.target.value || null)}
            style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }}
            aria-label="Exclude subsector"
          >
            <option value="">Exclude subsector…</option>
            {allSubsectors.map((s) => (
              <option key={s} value={s}>Exclude {s}</option>
            ))}
          </select>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter ticker / name"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--chrome-border)", color: "var(--text-primary)", fontSize: 11, padding: "2px 6px" }}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 10, color: "var(--text-muted)" }}>
        <span>
          Box-score columns show each box&apos;s peer-relative z + its z reconstructed over the last 8 quarters. Click a
          box cell to break it out into its components — each with its z-bar and 8-quarter trend — appended on the right
          for every name.
        </span>
        {expandedDef ? (
          <button
            type="button"
            onClick={() => setExpandedBox(null)}
            title="Collapse the component breakout"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "none",
              border: "1px solid var(--color-accent)",
              color: "var(--color-accent)",
              cursor: "pointer",
              fontSize: 10,
              fontWeight: 700,
              padding: "2px 8px",
              whiteSpace: "nowrap",
              flex: "0 0 auto",
            }}
          >
            <span>✕</span> {expandedDef.label} breakout
          </button>
        ) : null}
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="bb-table" style={{ fontSize: 11, borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
              <SortHeader label="#" sortKey="rank" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader label="Ticker" sortKey="ticker" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader label="Company" sortKey="company" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
              {PERF_COLS.map((c) => (
                <SortHeader
                  key={c.h}
                  label={c.label}
                  sortKey={`perf_${c.h}` as SortKey}
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  align="right"
                  title={`${c.label} total return · percentile-shaded across all names (50th pct = neutral)`}
                />
              ))}
              <SortHeader label="Sector" sortKey="sector" activeKey={sortKey} dir={sortDir} onSort={handleSort} width={META_COL_W} />
              <SortHeader label="Subsector" sortKey="subsector" activeKey={sortKey} dir={sortDir} onSort={handleSort} width={META_COL_W} />
              <SortHeader label="Composite" sortKey="composite" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" width={META_COL_W} title="Equal-weight average of available box scores (requires ≥ 8 valid boxes)" />
              <SortHeader label="Decile" sortKey="decile" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              {BOX_COLS.map((c) => (
                <SortHeader
                  key={c.key}
                  label={c.label}
                  sortKey={`box:${c.key}` as SortKey}
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  align="center"
                  title={c.title}
                  tilt={expanded}
                  width={expanded ? WRAP_BOX_W : undefined}
                  frame={c.key === expandedBox}
                />
              ))}
              {expanded && expandedDef
                ? expandedDef.components.map((c, ci) => (
                    <th
                      key={c.key}
                      style={{ ...wrapTh, width: WRAP_COMP_W, borderLeft: ci === 0 ? "2px solid var(--color-accent)" : undefined }}
                      title={`${expandedDef.label} — ${c.label}`}
                    >
                      <WrapLabel emphasis>{c.label}</WrapLabel>
                    </th>
                  ))
                : null}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, ri) => {
              const isLastRow = ri === pageRows.length - 1;
              return (
              <tr key={r.ticker} style={{ borderTop: "1px solid var(--chrome-border)" }}>
                <td style={{ padding: "2px 6px", color: "var(--text-muted)" }}>{r.rank ?? ""}</td>
                <td style={{ padding: "2px 6px", whiteSpace: "nowrap" }}>
                  <button type="button" onClick={() => onSelectTicker(r.ticker)} style={{ color: "var(--color-accent)", fontWeight: 700, fontSize: 11, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                    {r.ticker}
                  </button>
                  {r.newArrival ? <span style={{ marginLeft: 4, fontSize: 8, fontWeight: 700, color: "#000", background: "var(--color-positive)", padding: "0 3px" }}>NEW</span> : null}
                  {r.trapFlag ? <span style={{ marginLeft: 4, fontSize: 8, fontWeight: 700, color: "#fff", background: "var(--bb-red)", padding: "0 3px" }} title="Accruals trap flag">TRAP</span> : null}
                </td>
                <td style={{ padding: "2px 6px", color: "var(--text-primary)", maxWidth: companyMax, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span style={{ verticalAlign: "middle" }}>{r.companyName}</span>
                  <FlagChips flags={r.flags} />
                </td>
                {PERF_COLS.map((c) => {
                  const v = r.returns?.[c.h] ?? null;
                  const pct = perfPercentiles[c.h].get(r.ticker);
                  const hasHeat = pct != null && v != null && Number.isFinite(v);
                  const bg = hasHeat ? heatPercentileBloomberg(pct, "signed") : "var(--bg-surface)";
                  return (
                    <td
                      key={c.h}
                      className="bb-num"
                      style={{
                        padding: perfPad,
                        textAlign: "right",
                        background: hasHeat ? bg : undefined,
                        color: hasHeat ? pickTextColor(bg) : "var(--text-muted)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {formatMetricValue(v, "RETURN")}
                    </td>
                  );
                })}
                <td style={{ padding: "2px 6px", color: sectorColor(r.sector), width: META_COL_W, maxWidth: META_COL_W, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.sector ?? undefined}>{r.sector ?? "—"}</td>
                <td style={{ padding: "2px 6px", color: subThemeColor(r.sector, r.subsector), width: META_COL_W, maxWidth: META_COL_W, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.subsector ?? undefined}>{r.subsector ?? "—"}</td>
                <td
                  style={{ padding: perfPad, width: META_COL_W, maxWidth: META_COL_W, textAlign: "right", color: r.composite != null ? heatSignedBloomberg(r.composite, 1.5) : "var(--text-muted)", fontWeight: 600 }}
                  className="bb-num"
                  title={r.validBoxCount != null ? `${r.validBoxCount}/9 valid boxes` : undefined}
                >
                  {r.composite != null ? r.composite.toFixed(2) : "—"}
                </td>
                <td style={{ padding: "2px 6px", textAlign: "right" }} className="bb-num">{r.subsectorDecile ?? r.sectorDecile ?? "—"}</td>
                {BOX_COLS.map((c) => {
                  const isActive = expandedBox === c.key;
                  const frameShadow = isActive
                    ? `inset 1px 0 0 var(--color-accent), inset -1px 0 0 var(--color-accent)${isLastRow ? ", inset 0 -1px 0 var(--color-accent)" : ""}`
                    : undefined;
                  return (
                    <td
                      key={c.key}
                      onClick={() => toggleBox(c.key)}
                      style={{
                        padding: expanded ? "2px 4px" : "2px 6px",
                        cursor: "pointer",
                        boxShadow: frameShadow,
                      }}
                      title={
                        expanded
                          ? `${c.title}\n(click to ${isActive ? "collapse" : "break out its components"})`
                          : `${c.title}\n(click to break out its components)`
                      }
                    >
                      {expanded ? (
                        <BoxScoreCell z={r.boxScores?.[c.key] ?? null} title={c.title} />
                      ) : (
                        <CollapsedBoxCell
                          score={r.boxScores?.[c.key] ?? null}
                          history={r.boxScoreHistory?.[c.key]}
                          title={c.title}
                        />
                      )}
                    </td>
                  );
                })}
                {expanded && expandedDef
                  ? expandedDef.components.map((c, ci) => {
                      const box = r.boxes?.find((b) => b.key === expandedBox);
                      const audit = box?.components.find((ac) => ac.key === flatKey(expandedBox, c.key));
                      const z = audit?.z ?? null;
                      const raw = audit?.raw ?? null;
                      const series = audit ? r.componentSeries?.[audit.key] ?? [] : [];
                      const sparkColor =
                        z == null || !Number.isFinite(z) ? "var(--text-muted)" : heatSignedBloomberg(z, 2);
                      return (
                        <td
                          key={c.key}
                          style={{ padding: "2px 6px", borderLeft: ci === 0 ? "2px solid var(--color-accent)" : undefined }}
                          title={`${c.label}\nz ${z == null || !Number.isFinite(z) ? "—" : z.toFixed(2)} · raw ${formatRaw(raw)}`}
                        >
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            <ZBar z={z} w={EXP_BAR_W} h={BAR_H} />
                            {series.length >= 2 ? (
                              <MiniSparkline data={series} color={sparkColor} w={EXP_SPARK_W} h={SPARK_H} />
                            ) : (
                              <span style={{ display: "inline-block", width: EXP_SPARK_W, height: SPARK_H, flex: "0 0 auto" }} />
                            )}
                          </span>
                        </td>
                      );
                    })
                  : null}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {sorted.length > PAGE_SIZE ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--text-muted)" }}>
          <button
            type="button"
            className="bb-tab"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            style={{ border: "1px solid var(--chrome-border)", opacity: safePage <= 1 ? 0.4 : 1 }}
          >
            Prev
          </button>
          <span>
            Page {safePage} of {totalPages} · showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, sorted.length)} of {sorted.length}
          </span>
          <button
            type="button"
            className="bb-tab"
            disabled={safePage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            style={{ border: "1px solid var(--chrome-border)", opacity: safePage >= totalPages ? 0.4 : 1 }}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

function formatRaw(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return Math.abs(v) >= 1000 ? v.toExponential(1) : v.toFixed(3);
}
