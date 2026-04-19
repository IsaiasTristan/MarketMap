"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Horizon } from "@/domain/entities/horizons";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import type { MetricKind } from "@/domain/entities/analytics";
import { heatmapRgb } from "@/domain/calculations/heatmap";
import { HORIZON_LABEL, formatMetricValue } from "@/lib/format";

type ApiRow = {
  key: string;
  label: string;
  sector?: string;
  subTheme?: string;
  ticker?: string;
  cells: Record<Horizon, number | null>;
};

type ApiPayload = {
  ok: boolean;
  metric: MetricKind;
  benchmark: string;
  asOf: string | null;
  warnings: string[];
  horizons: Horizon[];
  columnRanges: { min: Record<string, number>; max: Record<string, number> };
  rows: ApiRow[];
};

type SortState = { horizon: Horizon; dir: "asc" | "desc" } | null;

type CompanyLeaf = {
  ticker: string;
  name: string;
  cells: Record<Horizon, number | null>;
};

type SubThemeNode = {
  sector: string;
  subTheme: string;
  cells: Record<Horizon, number | null>;
  companies: CompanyLeaf[];
};

type SectorNode = {
  sector: string;
  cells: Record<Horizon, number | null>;
  subThemes: SubThemeNode[];
};

type LevelKey = "SECTOR" | "SUB_THEME" | "COMPANY";

type RangeMap = Record<Horizon, { min: number; max: number }>;

type RowPosition = "first" | "middle" | "last" | "only";

type DisplayRow =
  | {
      kind: "SECTOR";
      node: SectorNode;
      expanded: boolean;
      hasExpansion: boolean;
    }
  | {
      kind: "SUB_THEME";
      node: SubThemeNode;
      expanded: boolean;
      position: RowPosition;
      hasExpandedTickers: boolean;
    }
  | {
      kind: "COMPANY";
      sector: string;
      subTheme: string;
      company: CompanyLeaf;
      position: RowPosition;
    }
  | { kind: "GAP"; key: string };

const TOTAL_COLS = 3 + HORIZON_ORDER.length;

export function MarketMapClient({
  universeId,
  reloadToken = 0,
  onLoaded,
}: {
  universeId: string;
  reloadToken?: number;
  onLoaded?: () => void;
}) {
  const [metric, setMetric] = useState<MetricKind>("RETURN");
  const [benchmark, setBenchmark] = useState<"SP500" | "NASDAQ" | "DOW">(
    "SP500"
  );
  const [data, setData] = useState<ApiPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<SortState>({ horizon: "Y1", dir: "desc" });
  const [expandedSectors, setExpandedSectors] = useState<Set<string>>(
    () => new Set()
  );
  const [expandedSubThemes, setExpandedSubThemes] = useState<Set<string>>(
    () => new Set()
  );

  const qs = useMemo(() => {
    const u = new URLSearchParams();
    u.set("metric", metric);
    u.set("rowLevel", "COMPANY");
    u.set("benchmark", benchmark);
    return u.toString();
  }, [metric, benchmark]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/universes/${universeId}/market-map?${qs}`,
        { cache: "no-store" }
      );
      const j = (await res.json()) as ApiPayload & { error?: string };
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      setData(j);
      onLoaded?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [universeId, qs, onLoaded]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const tree = useMemo<SectorNode[]>(
    () => (data?.rows ? buildTree(data.rows) : []),
    [data]
  );

  // Sort each level by the active horizon so sector / sub-theme / ticker rows
  // all reflect the same ranking once the user clicks a horizon column.
  const sortedTree = useMemo<SectorNode[]>(() => {
    if (tree.length === 0) return tree;
    const cmp = makeComparator(sort);
    if (!cmp) return tree;
    return [...tree]
      .sort((a, b) => cmp(a.cells, b.cells))
      .map((s) => ({
        ...s,
        subThemes: [...s.subThemes]
          .sort((a, b) => cmp(a.cells, b.cells))
          .map((st) => ({
            ...st,
            companies: [...st.companies].sort((a, b) =>
              cmp(a.cells, b.cells)
            ),
          })),
      }));
  }, [tree, sort]);

  const allSectorKeys = useMemo(
    () => sortedTree.map((s) => s.sector),
    [sortedTree]
  );
  const sectorsAllExpanded =
    allSectorKeys.length > 0 &&
    allSectorKeys.every((k) => expandedSectors.has(k));

  const showAllSubThemes = useCallback(() => {
    setExpandedSectors(new Set(allSectorKeys));
  }, [allSectorKeys]);

  const hideAllSubThemes = useCallback(() => {
    setExpandedSectors(new Set());
    setExpandedSubThemes(new Set());
  }, []);

  const toggleSector = useCallback((sector: string) => {
    setExpandedSectors((prev) => toggleInSet(prev, sector));
  }, []);

  const toggleSubTheme = useCallback((sector: string, subTheme: string) => {
    const k = subThemeKey(sector, subTheme);
    setExpandedSubThemes((prev) => toggleInSet(prev, k));
  }, []);

  // Walk the sorted tree once and produce the flat list of rows we render.
  // Sub-theme / ticker rows carry a `position` so the very last visible row of
  // a sector block can drop the bottom-border that ties the block together.
  const displayRows = useMemo<DisplayRow[]>(() => {
    const out: DisplayRow[] = [];
    sortedTree.forEach((s, sIdx) => {
      if (sIdx > 0) out.push({ kind: "GAP", key: `gap:${s.sector}` });
      const sectorOpen = expandedSectors.has(s.sector);
      out.push({
        kind: "SECTOR",
        node: s,
        expanded: sectorOpen,
        hasExpansion: sectorOpen && s.subThemes.length > 0,
      });
      if (!sectorOpen) return;
      s.subThemes.forEach((st, stIdx) => {
        const subOpen = expandedSubThemes.has(
          subThemeKey(st.sector, st.subTheme)
        );
        const isLastSub = stIdx === s.subThemes.length - 1;
        out.push({
          kind: "SUB_THEME",
          node: st,
          expanded: subOpen,
          position: positionOf(stIdx, s.subThemes.length),
          hasExpandedTickers: subOpen && st.companies.length > 0,
        });
        if (!subOpen) return;
        st.companies.forEach((co, coIdx) => {
          const isLastCo = coIdx === st.companies.length - 1;
          // The very last company of the very last sub-theme also closes the
          // overall sector block, so flag it as "last" to drop the trailing
          // divider line.
          const pos: RowPosition =
            isLastCo && isLastSub
              ? "last"
              : positionOf(coIdx, st.companies.length);
          out.push({
            kind: "COMPANY",
            sector: st.sector,
            subTheme: st.subTheme,
            company: co,
            position: pos,
          });
        });
      });
    });
    return out;
  }, [sortedTree, expandedSectors, expandedSubThemes]);

  // Per-level heatmap ranges keep aggregate rows from washing out, since they
  // have a tighter spread than the underlying company values.
  const ranges = useMemo<Record<LevelKey, RangeMap>>(() => {
    const sectorCells = sortedTree.map((s) => s.cells);
    const subCells = sortedTree.flatMap((s) =>
      s.subThemes.map((st) => st.cells)
    );
    const companyCells: RangeMap = data?.columnRanges
      ? cellsRangeFromMinMax(data.columnRanges)
      : computeRange([]);
    return {
      SECTOR: computeRange(sectorCells),
      SUB_THEME: computeRange(subCells),
      COMPANY: companyCells,
    };
  }, [sortedTree, data]);

  // The header strip uses the sector aggregate row so users can see at a
  // glance which horizon the universe is strongest on right now.
  const horizonAverages = useMemo(() => {
    const out = {} as Record<Horizon, number | null>;
    for (const h of HORIZON_ORDER) {
      const vals = sortedTree
        .map((s) => s.cells[h])
        .filter((v): v is number => v != null && Number.isFinite(v));
      out[h] = vals.length
        ? vals.reduce((a, b) => a + b, 0) / vals.length
        : null;
    }
    return out;
  }, [sortedTree]);

  const horizonHeaderRange = useMemo(() => {
    const vals = HORIZON_ORDER.map((h) => horizonAverages[h]).filter(
      (v): v is number => v != null && Number.isFinite(v)
    );
    if (vals.length === 0) return { min: 0, max: 0 };
    return { min: Math.min(...vals), max: Math.max(...vals) };
  }, [horizonAverages]);

  const toggleSort = (h: Horizon) => {
    setSort((prev) => {
      if (!prev || prev.horizon !== h) return { horizon: h, dir: "desc" };
      return { horizon: h, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  return (
    <div>
      <div style={controlRow}>
        <label>
          <div style={labelStyle}>Metric</div>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as MetricKind)}
            style={selectStyle}
          >
            <option value="RETURN">Return</option>
            <option value="EXCESS_RETURN">Excess return</option>
            <option value="VOLATILITY">Annualized realized volatility</option>
            <option value="SHARPE">Sharpe ratio</option>
          </select>
        </label>
        {(metric === "EXCESS_RETURN" || metric === "RETURN") && (
          <label>
            <div style={labelStyle}>Benchmark (excess)</div>
            <select
              value={benchmark}
              onChange={(e) =>
                setBenchmark(e.target.value as typeof benchmark)
              }
              style={selectStyle}
            >
              <option value="SP500">S&amp;P 500</option>
              <option value="NASDAQ">NASDAQ</option>
              <option value="DOW">DOW</option>
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={sectorsAllExpanded ? hideAllSubThemes : showAllSubThemes}
          style={sectorsAllExpanded ? btnGhostActive : btnGhost}
          disabled={sortedTree.length === 0}
          title={
            sectorsAllExpanded
              ? "Collapse every sector back to the sector-only comparison"
              : "Break every sector out into its sub-themes"
          }
        >
          {sectorsAllExpanded ? "Hide sub-themes" : "Show sub-themes"}
        </button>
        {loading && (
          <span style={{ color: "#8c99a8", fontSize: "0.85rem" }}>
            Loading…
          </span>
        )}
      </div>

      {err && (
        <p style={{ color: "#ff8d8d" }} role="alert">
          {err}
        </p>
      )}
      {data?.warnings?.length ? (
        <ul
          style={{
            color: "#d5a64a",
            fontSize: "0.88rem",
            marginBottom: "0.5rem",
          }}
        >
          {data.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}

      <Legend metric={metric} />

      <div style={tableWrap}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={{ ...thStyle, textAlign: "left", width: "22%" }}>
                Sector
              </th>
              <th style={{ ...thStyle, textAlign: "left", width: "20%" }}>
                Sub-Theme
              </th>
              <th style={{ ...thStyle, textAlign: "left", width: "12%" }}>
                Ticker
              </th>
              {HORIZON_ORDER.map((h) => {
                const avg = horizonAverages[h];
                const headerBg = horizonHeaderRgb(
                  avg,
                  horizonHeaderRange.min,
                  horizonHeaderRange.max,
                  metric
                );
                const tip =
                  avg == null
                    ? "Sort"
                    : `Avg ${formatMetricValue(avg, metric)} • Click to sort`;
                return (
                  <th
                    key={h}
                    style={{
                      ...thStyle,
                      cursor: "pointer",
                      userSelect: "none",
                      background: headerBg,
                      color: pickTextColor(headerBg),
                    }}
                    onClick={() => toggleSort(h)}
                    title={tip}
                  >
                    {HORIZON_LABEL[h]}
                    {sort?.horizon === h
                      ? sort.dir === "asc"
                        ? " ▲"
                        : " ▼"
                      : ""}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => {
              if (row.kind === "GAP") {
                return (
                  <tr key={row.key} style={gapRowStyle} aria-hidden="true">
                    <td style={gapCellStyle} colSpan={TOTAL_COLS} />
                  </tr>
                );
              }
              if (row.kind === "SECTOR") {
                return (
                  <SectorTableRow
                    key={`sec:${row.node.sector}`}
                    node={row.node}
                    expanded={row.expanded}
                    hasExpansion={row.hasExpansion}
                    metric={metric}
                    range={ranges.SECTOR}
                    onToggle={() => toggleSector(row.node.sector)}
                  />
                );
              }
              if (row.kind === "SUB_THEME") {
                return (
                  <SubThemeTableRow
                    key={`sub:${row.node.sector}|${row.node.subTheme}`}
                    node={row.node}
                    expanded={row.expanded}
                    position={row.position}
                    hasExpandedTickers={row.hasExpandedTickers}
                    metric={metric}
                    range={ranges.SUB_THEME}
                    onToggle={() =>
                      toggleSubTheme(row.node.sector, row.node.subTheme)
                    }
                  />
                );
              }
              return (
                <CompanyTableRow
                  key={`co:${row.sector}|${row.subTheme}|${row.company.ticker}`}
                  company={row.company}
                  position={row.position}
                  metric={metric}
                  range={ranges.COMPANY}
                />
              );
            })}
            {displayRows.length === 0 && !loading && (
              <tr>
                <td
                  style={{ ...emptyStateCell, color: "#8c99a8" }}
                  colSpan={TOTAL_COLS}
                >
                  No data to display.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SectorTableRow({
  node,
  expanded,
  hasExpansion,
  metric,
  range,
  onToggle,
}: {
  node: SectorNode;
  expanded: boolean;
  hasExpansion: boolean;
  metric: MetricKind;
  range: RangeMap;
  onToggle: () => void;
}) {
  const labelCell: CSSProperties = {
    ...sectorLabelCell,
    // When the sector is open we want it to read as the "header of a block",
    // so drop the bottom border (the sub-themes pick up directly underneath
    // with no visible seam) and lean a bit more on background contrast.
    borderBottomColor: hasExpansion ? "transparent" : "#222b3a",
    boxShadow: expanded
      ? "inset 4px 0 0 #d5a64a"
      : "inset 4px 0 0 transparent",
  };
  const filler: CSSProperties = {
    ...sectorEmptyCell,
    borderBottomColor: hasExpansion ? "transparent" : "#222b3a",
  };
  return (
    <tr style={sectorRowStyle}>
      <td style={labelCell}>
        <button
          type="button"
          onClick={onToggle}
          style={treeToggleBtn}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} sub-themes for ${
            node.sector
          }`}
        >
          <span style={chevronStyle(expanded, "#f0b65d")}>
            {expanded ? "▼" : "▶"}
          </span>
          <span style={sectorLabelText}>{node.sector}</span>
        </button>
      </td>
      <td style={filler} />
      <td style={filler} />
      {HORIZON_ORDER.map((h) =>
        renderHeatCell(h, node.cells[h], metric, range[h], hasExpansion, "SECTOR")
      )}
    </tr>
  );
}

function SubThemeTableRow({
  node,
  expanded,
  position,
  hasExpandedTickers,
  metric,
  range,
  onToggle,
}: {
  node: SubThemeNode;
  expanded: boolean;
  position: RowPosition;
  hasExpandedTickers: boolean;
  metric: MetricKind;
  range: RangeMap;
  onToggle: () => void;
}) {
  // We hide the divider when this row is followed by either more sub-themes
  // (next sub-theme draws its own seam) or an expanded ticker block (we want
  // a clean handoff to the company rows).
  const hideBottom =
    position !== "last" && position !== "only" ? false : hasExpandedTickers;
  const sectorCell: CSSProperties = {
    ...subThemeSectorCell,
    borderBottomColor: hideBottom ? "transparent" : "#1c2533",
  };
  const labelCell: CSSProperties = {
    ...subThemeLabelCell,
    borderBottomColor: hideBottom ? "transparent" : "#1c2533",
  };
  const trailing: CSSProperties = {
    ...subThemeTrailingCell,
    borderBottomColor: hideBottom ? "transparent" : "#1c2533",
  };
  return (
    <tr style={subThemeRowStyle}>
      <td style={sectorCell} />
      <td style={labelCell}>
        <button
          type="button"
          onClick={onToggle}
          style={treeToggleBtn}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} tickers for ${
            node.subTheme
          }`}
        >
          <span style={chevronStyle(expanded, "#9eafc4")}>
            {expanded ? "▼" : "▶"}
          </span>
          <span style={subThemeLabelText}>{node.subTheme}</span>
        </button>
      </td>
      <td style={trailing} />
      {HORIZON_ORDER.map((h) =>
        renderHeatCell(h, node.cells[h], metric, range[h], hideBottom, "SUB_THEME")
      )}
    </tr>
  );
}

function CompanyTableRow({
  company,
  position,
  metric,
  range,
}: {
  company: CompanyLeaf;
  position: RowPosition;
  metric: MetricKind;
  range: RangeMap;
}) {
  const isLast = position === "last" || position === "only";
  const sectorCell: CSSProperties = {
    ...companySectorCell,
    borderBottomColor: isLast ? "#1c2533" : "transparent",
  };
  const subCell: CSSProperties = {
    ...companySubCell,
    borderBottomColor: isLast ? "#1c2533" : "transparent",
  };
  const tickerCell: CSSProperties = {
    ...companyTickerCell,
    borderBottomColor: isLast ? "#1c2533" : "transparent",
  };
  return (
    <tr style={companyRowStyle}>
      <td style={sectorCell} />
      <td style={subCell} />
      <td style={tickerCell}>
        <span style={tickerText} title={company.name}>
          {company.ticker}
        </span>
      </td>
      {HORIZON_ORDER.map((h) =>
        renderHeatCell(h, company.cells[h], metric, range[h], !isLast, "COMPANY")
      )}
    </tr>
  );
}

function renderHeatCell(
  h: Horizon,
  v: number | null,
  metric: MetricKind,
  range: { min: number; max: number } | undefined,
  suppressBottom: boolean,
  level: LevelKey
) {
  const min = range?.min ?? 0;
  const max = range?.max ?? 0;
  const bg = heatmapRgb(v, metric, min, max);
  const density = HEAT_CELL_DENSITY[level];
  return (
    <td
      key={h}
      style={{
        ...tdCellStyle,
        padding: density.padding,
        fontSize: density.fontSize,
        fontWeight: density.fontWeight,
        background: bg,
        color: pickTextColor(bg),
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
        borderBottomColor: suppressBottom ? "transparent" : "#141d2c",
      }}
    >
      {formatMetricValue(v, metric)}
    </td>
  );
}

function buildTree(rows: ApiRow[]): SectorNode[] {
  const bySector = new Map<string, Map<string, CompanyLeaf[]>>();
  for (const r of rows) {
    const sector = r.sector ?? "Unknown";
    const sub = r.subTheme ?? "Unknown";
    const ticker = r.ticker ?? r.key;
    if (!bySector.has(sector)) bySector.set(sector, new Map());
    const sm = bySector.get(sector)!;
    if (!sm.has(sub)) sm.set(sub, []);
    sm.get(sub)!.push({
      ticker,
      // The API formats company labels as "TICKER — Name"; surface the name on
      // hover so the compact ticker column still hints at the underlying company.
      name: r.label.includes("—")
        ? r.label.split("—").slice(1).join("—").trim()
        : r.label,
      cells: r.cells,
    });
  }
  const sectors = [...bySector.keys()].sort();
  return sectors.map((sector) => {
    const sm = bySector.get(sector)!;
    const subs = [...sm.keys()].sort();
    const subThemes: SubThemeNode[] = subs.map((subTheme) => {
      const companies = sm.get(subTheme)!;
      return {
        sector,
        subTheme,
        companies,
        cells: averageCells(companies.map((c) => c.cells)),
      };
    });
    return {
      sector,
      subThemes,
      cells: averageCells(
        subThemes.flatMap((st) => st.companies.map((c) => c.cells))
      ),
    };
  });
}

function averageCells(
  list: Record<Horizon, number | null>[]
): Record<Horizon, number | null> {
  const out = {} as Record<Horizon, number | null>;
  for (const h of HORIZON_ORDER) {
    const vals = list
      .map((c) => c[h])
      .filter((v): v is number => v != null && Number.isFinite(v));
    out[h] = vals.length
      ? vals.reduce((a, b) => a + b, 0) / vals.length
      : null;
  }
  return out;
}

function computeRange(list: Record<Horizon, number | null>[]): RangeMap {
  const out = {} as RangeMap;
  for (const h of HORIZON_ORDER) {
    const vals = list
      .map((c) => c[h])
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (vals.length === 0) {
      out[h] = { min: 0, max: 0 };
    } else {
      out[h] = { min: Math.min(...vals), max: Math.max(...vals) };
    }
  }
  return out;
}

function cellsRangeFromMinMax(cr: {
  min: Record<string, number>;
  max: Record<string, number>;
}): RangeMap {
  const out = {} as RangeMap;
  for (const h of HORIZON_ORDER) {
    out[h] = { min: cr.min[h] ?? 0, max: cr.max[h] ?? 0 };
  }
  return out;
}

function makeComparator(sort: SortState) {
  if (!sort) return null;
  const h = sort.horizon;
  const dir = sort.dir;
  return (
    a: Record<Horizon, number | null>,
    b: Record<Horizon, number | null>
  ) => {
    const av = a[h];
    const bv = b[h];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const c = av - bv;
    return dir === "asc" ? c : -c;
  };
}

function toggleInSet<T>(prev: Set<T>, value: T): Set<T> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function subThemeKey(sector: string, subTheme: string): string {
  return `${sector}|||${subTheme}`;
}

function positionOf(idx: number, length: number): RowPosition {
  if (length === 1) return "only";
  if (idx === 0) return "first";
  if (idx === length - 1) return "last";
  return "middle";
}

/**
 * Colour the horizon header strictly by how this horizon ranks against the
 * other six on the same row level — the worst average is the deepest red, the
 * best is the deepest green, regardless of whether the entire row of averages
 * is positive or negative. For volatility (lower = better) the rank is
 * inverted so the "best performing" horizon still reads green.
 */
function horizonHeaderRgb(
  value: number | null,
  min: number,
  max: number,
  metric: MetricKind
): string {
  if (value == null || !Number.isFinite(value)) return "#141a25";
  if (max <= min) return "#1f2a3a";
  let t = (value - min) / (max - min);
  if (metric === "VOLATILITY") t = 1 - t;
  const synthetic = t * 2 - 1;
  return heatmapRgb(synthetic, "RETURN", -1, 1);
}

function pickTextColor(bg: string): string {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(bg);
  if (!m) return "#e6ebf2";
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#0b1018" : "#f5f8fd";
}

function Legend({ metric }: { metric: MetricKind }) {
  if (metric === "VOLATILITY") {
    return (
      <p style={legendText}>
        Volatility heatmap: lighter = lower annualized realized volatility, darker
        = higher.
      </p>
    );
  }
  if (metric === "SHARPE") {
    return (
      <p style={legendText}>
        Sharpe heatmap: red = weaker risk-adjusted, green = stronger (methodology
        in docs).
      </p>
    );
  }
  return (
    <p style={legendText}>
      Return / excess heatmap: red = negative, green = positive vs column min/max.
    </p>
  );
}

function chevronStyle(open: boolean, color: string): CSSProperties {
  return {
    display: "inline-block",
    width: "0.7rem",
    fontSize: "0.7rem",
    color,
    transition: "transform 120ms ease",
    transform: open ? "translateY(-1px)" : "translateY(0)",
  };
}

const controlRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1rem",
  marginBottom: "1rem",
  alignItems: "flex-end",
};

const labelStyle: CSSProperties = {
  fontSize: "0.72rem",
  color: "#8c99a8",
  marginBottom: 2,
};

const selectStyle: CSSProperties = {
  minWidth: "11rem",
  padding: "0.35rem 0.5rem",
  borderRadius: 5,
  border: "1px solid #2a3444",
  background: "#0f141d",
  color: "#e6ebf2",
};

const legendText: CSSProperties = {
  fontSize: "0.8rem",
  color: "#8c99a8",
  marginBottom: "0.5rem",
};

const tableWrap: CSSProperties = {
  overflowX: "auto",
  border: "1px solid #1e2636",
  borderRadius: 8,
  background: "#0c111c",
};

const tableStyle: CSSProperties = {
  borderCollapse: "separate",
  borderSpacing: 0,
  width: "100%",
  fontSize: "0.88rem",
};

const thStyle: CSSProperties = {
  padding: "0.55rem 0.7rem",
  borderBottom: "1px solid #2a3444",
  background: "#141a25",
  color: "#c7d0dc",
  textAlign: "right",
  whiteSpace: "nowrap",
  fontWeight: 600,
};

// Base styles for the label column cells. Borders use solid 1px lines whose
// colour is overridden per-row so we can hide seams within an expanded block
// while still drawing one at the bottom of each block. Per-level overrides
// below adjust padding (density) and background tint so sectors, sub-themes,
// and tickers each read as visually distinct horizontal bands.
const labelCellBase: CSSProperties = {
  borderBottom: "1px solid #141d2c",
  whiteSpace: "nowrap",
  maxWidth: "20rem",
};

const tdCellStyle: CSSProperties = {
  borderBottom: "1px solid #141d2c",
};

// Heat cells inherit the same vertical density as their row level so the
// table breathes (sector) → tightens (sub-theme) → compacts (ticker).
const HEAT_CELL_DENSITY: Record<
  LevelKey,
  { padding: string; fontSize: string; fontWeight: number }
> = {
  SECTOR: { padding: "0.7rem 0.7rem", fontSize: "0.86rem", fontWeight: 600 },
  SUB_THEME: { padding: "0.42rem 0.7rem", fontSize: "0.84rem", fontWeight: 500 },
  COMPANY: { padding: "0.32rem 0.7rem", fontSize: "0.8rem", fontWeight: 500 },
};

// === Sector row (warm amber, tall, uppercase) ===
const SECTOR_BG = "#1c2638";

const sectorRowStyle: CSSProperties = {
  background: SECTOR_BG,
};

const sectorLabelCell: CSSProperties = {
  ...labelCellBase,
  padding: "0.7rem 0.85rem",
  background: SECTOR_BG,
};

const sectorEmptyCell: CSSProperties = {
  ...labelCellBase,
  padding: "0.7rem 0.85rem",
  background: SECTOR_BG,
};

const sectorLabelText: CSSProperties = {
  color: "#f0b65d",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.085em",
  fontSize: "0.82rem",
};

// === Sub-theme row (cool, mid-density, light text) ===
const SUB_THEME_BG = "#0e1624";

const subThemeRowStyle: CSSProperties = {
  background: SUB_THEME_BG,
};

const subThemeSectorCell: CSSProperties = {
  ...labelCellBase,
  padding: "0.42rem 0.85rem",
  background: SUB_THEME_BG,
  // Continuous "spine" down the sector column ties every sub-theme back to
  // its parent sector visually.
  boxShadow: "inset 4px 0 0 #2c3a55",
};

const subThemeLabelCell: CSSProperties = {
  ...labelCellBase,
  padding: "0.42rem 0.85rem",
  paddingLeft: "1.5rem",
  background: SUB_THEME_BG,
};

const subThemeTrailingCell: CSSProperties = {
  ...labelCellBase,
  padding: "0.42rem 0.85rem",
  background: SUB_THEME_BG,
};

const subThemeLabelText: CSSProperties = {
  color: "#d8e3f0",
  fontWeight: 500,
  fontSize: "0.86rem",
  letterSpacing: "0.005em",
};

// === Company row (compact, monospaced ticker, recessed) ===
const COMPANY_BG = "#091018";

const companyRowStyle: CSSProperties = {
  background: COMPANY_BG,
};

const companySectorCell: CSSProperties = {
  ...labelCellBase,
  padding: "0.32rem 0.85rem",
  background: COMPANY_BG,
  // Sector spine continues through company rows so the whole sector reads as
  // one connected block.
  boxShadow: "inset 4px 0 0 #2c3a55",
};

const companySubCell: CSSProperties = {
  ...labelCellBase,
  padding: "0.32rem 0.85rem",
  background: COMPANY_BG,
  // Secondary spine through the sub-theme column groups companies under
  // their sub-theme parent.
  boxShadow: "inset 3px 0 0 #243149",
};

const companyTickerCell: CSSProperties = {
  ...labelCellBase,
  padding: "0.32rem 0.85rem",
  paddingLeft: "1.95rem",
  background: COMPANY_BG,
};

const tickerText: CSSProperties = {
  color: "#9eb0c8",
  fontWeight: 500,
  fontSize: "0.8rem",
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "0.04em",
  fontFamily:
    'ui-monospace, SFMono-Regular, "JetBrains Mono", "Cascadia Mono", Menlo, monospace',
};

// === Gap row between sectors ===
const gapRowStyle: CSSProperties = {
  background: "#06090f",
};

const gapCellStyle: CSSProperties = {
  height: 12,
  padding: 0,
  background: "#06090f",
  borderBottom: "none",
};

const emptyStateCell: CSSProperties = {
  ...labelCellBase,
  background: "transparent",
};

const treeToggleBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.55rem",
  background: "transparent",
  border: "none",
  color: "inherit",
  font: "inherit",
  padding: 0,
  cursor: "pointer",
  textAlign: "left",
};

const btnGhost: CSSProperties = {
  padding: "0.4rem 0.85rem",
  borderRadius: 6,
  border: "1px solid #384454",
  background: "transparent",
  color: "#c7d0dc",
  fontSize: "0.85rem",
  fontWeight: 500,
  cursor: "pointer",
};

const btnGhostActive: CSSProperties = {
  ...btnGhost,
  background: "#1f2a3d",
  borderColor: "#4a5b7a",
  color: "#f2f5f9",
};
