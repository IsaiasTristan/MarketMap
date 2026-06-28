"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { heatSignedBloomberg, heatPercentileBloomberg } from "@/components/analysis/ui/heat";
import { sectorColor, subThemeColor } from "@/lib/market-map/sector-colors";
import { formatMetricValue } from "@/lib/format";
import type { Horizon } from "@/domain/entities/horizons";
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

type SeriesKey = keyof NonNullable<DiscoveryRow["series"]>;

const SIGNAL_COLS: Array<{
  key: keyof DiscoveryRow["inflection"];
  zKey: string;
  seriesKey: SeriesKey;
  label: string;
  title: string;
}> = [
  { key: "grossMarginInflection", zKey: "grossMarginInflection", seriesKey: "grossMargin", label: "Gross Margin", title: "Gross-margin inflection (recent slope − prior slope, z within peers) · sparkline: TTM gross margin, last 8 quarters" },
  { key: "ebitdaMarginInflection", zKey: "ebitdaMarginInflection", seriesKey: "ebitdaMargin", label: "EBITDA Margin", title: "EBITDA-margin inflection (z) · sparkline: TTM EBITDA margin, last 8 quarters" },
  { key: "revenueGrowthAccel", zKey: "revenueGrowthAccel", seriesKey: "revenueGrowth", label: "Revenue Growth", title: "Revenue-growth acceleration (2nd derivative of YoY growth, z) · sparkline: YoY revenue growth, last 8 quarters" },
  { key: "fcfInflection", zKey: "fcfInflection", seriesKey: "fcf", label: "FCF", title: "Free-cash-flow inflection (z) · sparkline: TTM free cash flow, last 8 quarters" },
  { key: "roicTrend", zKey: "roicTrend", seriesKey: "roic", label: "ROIC", title: "ROIC trend (slope, z) · sparkline: ROIC, last 8 quarters" },
  { key: "deleveraging", zKey: "deleveraging", seriesKey: "netDebtToEbitda", label: "Δ Net Debt", title: "Deleveraging (net-debt/EBITDA falling, z) · sparkline: net-debt / EBITDA, last 8 quarters" },
];

type SortKey =
  | "rank"
  | "ticker"
  | "company"
  | "sector"
  | "subsector"
  | "composite"
  | "decile"
  | "grossMarginInflection"
  | "ebitdaMarginInflection"
  | "revenueGrowthAccel"
  | "fcfInflection"
  | "roicTrend"
  | "deleveraging"
  | "val"
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

/** z-score bar with the z value rendered in white inside the bar track. */
function ZBar({ z }: { z: number | null }) {
  if (z === null || !Number.isFinite(z)) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: BAR_W,
          height: BAR_H,
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
    <span style={{ position: "relative", display: "inline-block", width: BAR_W, height: BAR_H, background: "var(--bg-surface)", flex: "0 0 auto" }}>
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
function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  if (!data || data.length < 2) {
    return <span style={{ display: "inline-block", width: SPARK_W, height: SPARK_H, flex: "0 0 auto" }} />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 1.5;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * (SPARK_W - pad * 2) + pad;
      const y = SPARK_H - pad - ((v - min) / range) * (SPARK_H - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} style={{ display: "block", flex: "0 0 auto" }} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function InflectionCell({ z, data, title }: { z: number | null; data: number[]; title: string }) {
  const sparkColor =
    z === null || !Number.isFinite(z) || z === 0 ? "var(--text-muted)" : heatSignedBloomberg(z, 2);
  return (
    <span
      title={`${title}: ${z === null || !Number.isFinite(z) ? "n/a" : z.toFixed(2)}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
    >
      <ZBar z={z} />
      <MiniSparkline data={data} color={sparkColor} />
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
    case "val":
      return row.cheapness;
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

function SortHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = "left",
  title,
  rowSpan,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right" | "center";
  title?: string;
  rowSpan?: number;
}) {
  const active = activeKey === sortKey;
  return (
    <th
      rowSpan={rowSpan}
      style={{ padding: "3px 6px", textAlign: align, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", verticalAlign: rowSpan ? "bottom" : undefined }}
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
  onSectorFilterChange,
  onSubsectorFilterChange,
}: {
  rows: DiscoveryRow[];
  snapshotDate?: string;
  onSelectTicker: (t: string) => void;
  sectorFilter: string | null;
  subsectorFilter: string | null;
  onSectorFilterChange: (v: string | null) => void;
  onSubsectorFilterChange: (v: string | null) => void;
}) {
  const [onlyNew, setOnlyNew] = useState(false);
  const [hideTraps, setHideTraps] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<SortKey>("composite");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

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

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return rows.filter((r) => {
      if (onlyNew && !r.newArrival) return false;
      if (hideTraps && r.trapFlag) return false;
      if (sectorFilter && (r.sector?.trim() ?? "") !== sectorFilter) return false;
      if (subsectorFilter) {
        const sub = r.subsector?.trim() || r.sector?.trim() || "";
        if (sub !== subsectorFilter) return false;
      }
      if (q && !r.ticker.includes(q) && !(r.companyName ?? "").toUpperCase().includes(q)) return false;
      return true;
    });
  }, [rows, onlyNew, hideTraps, query, sectorFilter, subsectorFilter]);

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
  }, [onlyNew, hideTraps, query, sectorFilter, subsectorFilter, sortKey, sortDir]);

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
        <select
          value={sectorFilter ?? ""}
          onChange={(e) => {
            onSectorFilterChange(e.target.value || null);
            onSubsectorFilterChange(null);
          }}
          style={selectStyle}
          aria-label="Filter by sector"
        >
          <option value="">All sectors</option>
          {sectors.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select
          value={subsectorFilter ?? ""}
          onChange={(e) => onSubsectorFilterChange(e.target.value || null)}
          style={selectStyle}
          aria-label="Filter by subsector"
          disabled={subsectors.length === 0}
        >
          <option value="">All subsectors</option>
          {subsectors.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter ticker / name"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--chrome-border)", color: "var(--text-primary)", fontSize: 11, padding: "2px 6px" }}
        />
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="bb-table" style={{ fontSize: 11, borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
              <SortHeader label="#" sortKey="rank" activeKey={sortKey} dir={sortDir} onSort={handleSort} rowSpan={2} />
              <SortHeader label="Ticker" sortKey="ticker" activeKey={sortKey} dir={sortDir} onSort={handleSort} rowSpan={2} />
              <SortHeader label="Company" sortKey="company" activeKey={sortKey} dir={sortDir} onSort={handleSort} rowSpan={2} />
              {PERF_COLS.map((c) => (
                <SortHeader
                  key={c.h}
                  label={c.label}
                  sortKey={`perf_${c.h}` as SortKey}
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  align="right"
                  rowSpan={2}
                  title={`${c.label} total return · percentile-shaded across all names (50th pct = neutral)`}
                />
              ))}
              <SortHeader label="Sector" sortKey="sector" activeKey={sortKey} dir={sortDir} onSort={handleSort} rowSpan={2} />
              <SortHeader label="Subsector" sortKey="subsector" activeKey={sortKey} dir={sortDir} onSort={handleSort} rowSpan={2} />
              <SortHeader label="Composite" sortKey="composite" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" rowSpan={2} />
              <SortHeader label="Decile" sortKey="decile" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" rowSpan={2} />
              <th
                colSpan={SIGNAL_COLS.length}
                style={{ padding: "3px 6px", textAlign: "center", whiteSpace: "nowrap", borderBottom: "1px solid var(--chrome-border)", color: "var(--color-accent)", letterSpacing: 0.6, fontWeight: 700 }}
                title="Peer-group z-score of each inflection signal (bar + z), with the underlying 8-quarter series (sparkline)"
              >
                INFLECTION
              </th>
              <SortHeader label="Val" sortKey="val" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" title="Cheapness vs own 5y history (1 = cheapest)" rowSpan={2} />
            </tr>
            <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
              {SIGNAL_COLS.map((c) => (
                <SortHeader key={c.key} label={c.label} sortKey={c.zKey as SortKey} activeKey={sortKey} dir={sortDir} onSort={handleSort} align="center" title={c.title} />
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => (
              <tr key={r.ticker} style={{ borderTop: "1px solid var(--chrome-border)" }}>
                <td style={{ padding: "2px 6px", color: "var(--text-muted)" }}>{r.rank ?? ""}</td>
                <td style={{ padding: "2px 6px" }}>
                  <button type="button" onClick={() => onSelectTicker(r.ticker)} style={{ color: "var(--color-accent)", fontWeight: 700, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                    {r.ticker}
                  </button>
                  {r.newArrival ? <span style={{ marginLeft: 4, fontSize: 8, fontWeight: 700, color: "#000", background: "var(--color-positive)", padding: "0 3px" }}>NEW</span> : null}
                  {r.trapFlag ? <span style={{ marginLeft: 4, fontSize: 8, fontWeight: 700, color: "#fff", background: "var(--bb-red)", padding: "0 3px" }} title="Accruals trap flag">TRAP</span> : null}
                </td>
                <td style={{ padding: "2px 6px", color: "var(--text-primary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.companyName}</td>
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
                        padding: "2px 6px",
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
                <td style={{ padding: "2px 6px", color: sectorColor(r.sector), maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sector ?? "—"}</td>
                <td style={{ padding: "2px 6px", color: subThemeColor(r.sector, r.subsector), maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.subsector ?? "—"}</td>
                <td style={{ padding: "2px 6px", textAlign: "right", color: r.composite != null ? heatSignedBloomberg(r.composite, 1.5) : "var(--text-muted)", fontWeight: 600 }} className="bb-num">
                  {r.composite != null ? r.composite.toFixed(2) : "—"}
                </td>
                <td style={{ padding: "2px 6px", textAlign: "right" }} className="bb-num">{r.subsectorDecile ?? r.sectorDecile ?? "—"}</td>
                {SIGNAL_COLS.map((c) => (
                  <td key={c.key} style={{ padding: "2px 6px" }}>
                    <InflectionCell z={r.z?.[c.zKey] ?? null} data={r.series?.[c.seriesKey] ?? []} title={c.title} />
                  </td>
                ))}
                <td style={{ padding: "2px 6px", textAlign: "right" }} className="bb-num">
                  {r.cheapness != null ? r.cheapness.toFixed(2) : "—"}
                </td>
              </tr>
            ))}
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
