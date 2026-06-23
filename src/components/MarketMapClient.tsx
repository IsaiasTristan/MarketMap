"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Horizon } from "@/domain/entities/horizons";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import type { MetricKind } from "@/domain/entities/analytics";
import { heatmapRgb } from "@/domain/calculations/heatmap";
import { HORIZON_LABEL, formatMetricValue } from "@/lib/format";
import { FactorPerformanceTable } from "@/components/FactorPerformanceTable";
import { TopMoversTable } from "@/components/TopMoversTable";
import { useAnalysisStore } from "@/store/analysis";
import { FloatingPerStockDetail } from "@/components/analysis/factors/panels/FloatingPerStockDetail";
import type { PerStockResult } from "@/server/services/factor-per-stock.service";
import { isExcludedSector } from "@/lib/market-map/excluded-sectors";
import type { MarketSession } from "@/lib/market-map/market-session";

type ApiRow = {
  key: string;
  label: string;
  sector?: string;
  subTheme?: string;
  ticker?: string;
  cells: Record<Horizon, number | null>;
  lastDate?: string | null;
};

type ApiExtendedInfo = {
  requested: boolean;
  applied: boolean;
  /** True when the server has a usable extended-hours snapshot in memory
   *  right now. Drives the toggle's visibility during CLOSED periods so
   *  users can still flip between regular-close and the most recent
   *  PRE/POST overlay overnight / over weekends. */
  available: boolean;
  /** Which session the in-memory snapshot was captured under — `POST`
   *  for overnight/weekend after a normal trading day, `PRE` for the rare
   *  PRE→CLOSED transition. Drives the toggle's label and accent colour
   *  when the clock session is CLOSED. */
  session: MarketSession | null;
  asOf: string | null;
  tickerCount: number;
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
  extended?: ApiExtendedInfo;
};

type SortState = { horizon: Horizon; dir: "asc" | "desc" } | null;

type CompanyLeaf = {
  ticker: string;
  name: string;
  cells: Record<Horizon, number | null>;
  lastDate?: string | null;
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

/** One active ticker whose last bar trails the universe's freshest bar by
 *  more than STALE_TICKER_DAYS. Surfaced in the top-bar warning popup. */
export type StaleTickerInfo = {
  ticker: string;
  name: string;
  lastDate: string;
  daysBehind: number;
};

export type MarketMapLoadedInfo = {
  asOf: string | null;
  staleCalendarDays: number | null;
  /** Number of active tickers in the universe whose last bar trails the
   *  universe's freshest bar by more than STALE_TICKER_DAYS. Drives the
   *  "N of M tickers stale" sub-label on the top bar. */
  staleTickerCount: number;
  /** Total number of active tickers represented in the grid (denominator). */
  activeTickerCount: number;
  /** Per-ticker detail for the stale tickers, newest-trailing first, so the
   *  top-bar warning popup can name the affected stocks and their time gap. */
  staleTickers: StaleTickerInfo[];
};

/** A ticker is "stale" if its last bar trails the universe's freshest bar by
 *  more than this many calendar days. Counted against the universe-freshest
 *  bar (not wall-clock) so weekends / holidays / timezone don't false-flag. */
const STALE_TICKER_DAYS = 3;

export function MarketMapClient({
  universeId,
  reloadToken = 0,
  onLoaded,
  session = "CLOSED",
}: {
  universeId: string;
  reloadToken?: number;
  onLoaded?: (info: MarketMapLoadedInfo) => void;
  session?: MarketSession;
}) {
  // Whenever the server reports a usable extended-hours snapshot (live
  // during PRE/POST, or carried over into CLOSED until the next REGULAR
  // session wipes it) the user can flip between the overlaid grid and the
  // regular-close grid. Defaults ON so the most recent print is visible by
  // default. Sending `extended=1` to the API when there's nothing to
  // overlay is harmless — the route returns `applied: false` and the
  // close-based grid.
  const [showExtended, setShowExtended] = useState(true);
  const inExtendedSession = session === "PRE" || session === "POST";
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

  // Reuse the factors-tab popup machinery for ticker drill-down. The popup
  // is identified purely by ticker and reads its model/window/period config
  // from the global store, so the market map can share the React Query cache
  // with the Factors tab (same queryKey -> no duplicate fetch).
  const factorModel = useAnalysisStore((s) => s.factorModel);
  const factorWindow = useAnalysisStore((s) => s.factorWindow);
  const factorPeriod = useAnalysisStore((s) => s.factorPeriod);
  const openFactorDetailPanels = useAnalysisStore(
    (s) => s.openFactorDetailPanels,
  );
  const openFactorDetailPanel = useAnalysisStore(
    (s) => s.openFactorDetailPanel,
  );
  const closeFactorDetailPanel = useAnalysisStore(
    (s) => s.closeFactorDetailPanel,
  );

  const { data: perStockData, isLoading: perStockLoading } =
    useQuery<PerStockResult>({
      queryKey: ["factor-per-stock", factorModel, factorWindow, factorPeriod],
      queryFn: () =>
        fetch(
          `/api/analysis/factors/per-stock?model=${factorModel}&window=${factorWindow}&period=${factorPeriod}`,
        ).then((r) => r.json()),
      enabled: openFactorDetailPanels.length > 0,
      staleTime: 5 * 60_000,
    });

  const openTickerSet = useMemo(
    () => new Set(openFactorDetailPanels.map((p) => p.ticker)),
    [openFactorDetailPanels],
  );

  const handleSelectTicker = useCallback(
    (ticker: string) => {
      if (openTickerSet.has(ticker)) closeFactorDetailPanel(ticker);
      else openFactorDetailPanel(ticker);
    },
    [openTickerSet, closeFactorDetailPanel, openFactorDetailPanel],
  );

  const qs = useMemo(() => {
    const u = new URLSearchParams();
    u.set("metric", metric);
    u.set("rowLevel", "COMPANY");
    u.set("benchmark", benchmark);
    // Opt in to the overlay whenever the user wants it. The server is
    // responsible for deciding whether a snapshot actually exists to
    // apply; if not, it returns the close-based grid with
    // `extended.applied = false` and `extended.available` tells us
    // whether the toggle should be visible at all.
    if (showExtended) u.set("extended", "1");
    return u.toString();
  }, [metric, benchmark, showExtended]);

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
      // Drop sectors we explicitly hide from the Performance page (e.g.
      // INDEX & MACRO) at the boundary so every downstream surface — main
      // grid, Top Movers, top-bar telemetry — sees the same filtered universe.
      const filteredRows = j.rows.filter((r) => !isExcludedSector(r.sector));
      setData({ ...j, rows: filteredRows, extended: j.extended });
      const tickerDates = filteredRows
        .map((r) => r.lastDate)
        .filter((d): d is string => !!d);
      const newestLastDate = tickerDates.length
        ? tickerDates.reduce((a, b) => (a > b ? a : b))
        : null;
      const staleTickers: StaleTickerInfo[] = newestLastDate
        ? filteredRows
            .filter(
              (r): r is ApiRow & { lastDate: string } =>
                !!r.lastDate &&
                calendarDaysBetween(r.lastDate, newestLastDate) >
                  STALE_TICKER_DAYS
            )
            .map((r) => ({
              ticker: r.ticker ?? r.label,
              name: r.label,
              lastDate: r.lastDate,
              daysBehind: calendarDaysBetween(r.lastDate, newestLastDate),
            }))
            .sort((a, b) => b.daysBehind - a.daysBehind)
        : [];
      onLoaded?.({
        asOf: j.asOf ?? null,
        staleCalendarDays: j.asOf ? calendarDaysBetween(j.asOf, isoToday()) : null,
        staleTickerCount: staleTickers.length,
        activeTickerCount: filteredRows.length,
        staleTickers,
      });
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
        {metric === "EXCESS_RETURN" && (
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
        {/* The toggle is visible whenever the server has snapshot data to
            display — actively during PRE/POST (clock-driven, shown even
            before the first response so the chip doesn't blink in), and
            during CLOSED whenever the API reports an available snapshot
            (i.e. a recent PRE/POST sweep still in memory). Hidden during
            REGULAR (no overlay applies) and during CLOSED with no
            snapshot (toggle would be a no-op). */}
        {(inExtendedSession || data?.extended?.available) && (
          <ExtendedHoursToggle
            clockSession={session}
            showExtended={showExtended}
            onToggle={() => setShowExtended((v) => !v)}
            extended={data?.extended ?? null}
          />
        )}
        {loading && (
          <span style={{ color: "var(--text-secondary)", fontSize: "12px" }}>
            Loading…
          </span>
        )}
      </div>

      {err && (
        <p style={{ color: "var(--color-negative)" }} role="alert">
          {err}
        </p>
      )}
      {data?.warnings?.length ? (
        <ul
          style={{
            color: "var(--color-warning)",
            fontSize: "12px",
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
              <th style={{ ...thStyle, textAlign: "left", width: "1%" }}>
                Sector
              </th>
              <th style={{ ...thStyle, textAlign: "left", width: "1%" }}>
                Sub-Theme
              </th>
              <th style={{ ...thStyle, textAlign: "left", width: "1%" }}>
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
                  universeAsOf={data?.asOf ?? null}
                  selected={openTickerSet.has(row.company.ticker)}
                  onSelectTicker={handleSelectTicker}
                />
              );
            })}
            {displayRows.length === 0 && !loading && (
              <tr>
                <td
                  style={{ ...emptyStateCell, color: "var(--text-secondary)" }}
                  colSpan={TOTAL_COLS}
                >
                  No data to display.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <FactorPerformanceTable
        metric={metric}
        benchmark={benchmark}
        reloadToken={reloadToken}
      />

      <TopMoversTable
        universeId={universeId}
        reloadToken={reloadToken}
        companyLeaves={
          metric === "RETURN"
            ? sortedTree.flatMap((s) =>
                s.subThemes.flatMap((st) =>
                  st.companies.map((c) => ({
                    ...c,
                    sector: s.sector,
                    subTheme: st.subTheme,
                  })),
                ),
              )
            : null
        }
        onSelectTicker={handleSelectTicker}
        selectedTickers={openTickerSet}
      />

      {perStockData &&
        openFactorDetailPanels.map((panel) => (
          <FloatingPerStockDetail
            key={panel.ticker}
            panel={panel}
            data={perStockData}
            // Market-map popup always opens on the live 1D decomposition —
            // the chart price header already shows the live 1D move, and the
            // factor waterfall now mirrors it via /api/analysis/factors/
            // per-stock/live-1d. The Factors-tab Per-Stock view continues
            // to honour the global Attribution Period control.
            periodOverride="1D"
          />
        ))}
      {perStockLoading && openFactorDetailPanels.length > 0 && !perStockData && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            right: 16,
            bottom: 16,
            zIndex: 100,
            padding: "6px 12px",
            background: "var(--bg-surface)",
            border: "1px solid var(--bg-border)",
            color: "var(--text-secondary)",
            fontSize: 12,
            fontFamily:
              'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace',
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
          }}
        >
          Loading factor detail…
        </div>
      )}
    </div>
  );
}

function ExtendedHoursToggle({
  clockSession,
  showExtended,
  onToggle,
  extended,
}: {
  clockSession: MarketSession;
  showExtended: boolean;
  onToggle: () => void;
  extended: ApiExtendedInfo | null;
}) {
  // The displayed session label and accent colour follow the SNAPSHOT
  // session whenever one is available — so during CLOSED-after-POST the
  // toggle still says "Show after-hours" with the dark-red accent that
  // matches the prior status chip, not whatever the clock thinks.
  // Falls back to the clock during the brief interval before the first
  // API response lands.
  const displaySession: "PRE" | "POST" =
    extended?.session === "PRE" || extended?.session === "POST"
      ? extended.session
      : clockSession === "PRE"
        ? "PRE"
        : "POST";

  // The "Closed" clock session is a meaningful staleness signal: the
  // snapshot is no longer being refreshed; the user is looking at the
  // most recent extended-hours move (e.g. last night's POST, or Friday's
  // POST on a Saturday). Surface that subtly in the title so users don't
  // misread an overnight snapshot as live.
  const isCarryover = clockSession === "CLOSED";

  // Two distinct verbs depending on what the toggle does next:
  //   showExtended = true  -> button reverts to close-based grid
  //   showExtended = false -> button restores the extended-hours overlay
  const label = showExtended
    ? "Revert to close"
    : displaySession === "PRE"
      ? "Show pre-market"
      : "Show after-hours";
  const title = showExtended
    ? "Switch the grid back to regular-session close prices."
    : displaySession === "PRE"
      ? `Overlay ${isCarryover ? "the most recent" : "today's"} pre-market prints onto every horizon column.`
      : `Overlay ${isCarryover ? "the most recent" : "today's"} post-market prints onto every horizon column.`;

  const asOfHint =
    showExtended && extended?.applied && extended.asOf
      ? `${displaySession === "PRE" ? "Pre-market" : "After-hours"} as of ${formatExtendedAsOf(extended.asOf)}`
      : null;
  return (
    <span style={extendedToggleWrap}>
      <button
        type="button"
        onClick={onToggle}
        style={
          showExtended ? extendedToggleActive(displaySession) : extendedToggleIdle
        }
        title={title}
      >
        {label}
      </button>
      {asOfHint && <span style={extendedAsOf}>{asOfHint}</span>}
    </span>
  );
}

function formatExtendedAsOf(iso: string): string {
  // ISO timestamp -> HH:MM in the user's local time zone. Falls back to the
  // raw string if Date parsing fails, so a malformed snapshot never blanks
  // the chip.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
    borderBottomColor: hasExpansion ? "transparent" : "var(--bg-border)",
    boxShadow: expanded
      ? "inset 4px 0 0 var(--color-accent)"
      : "inset 4px 0 0 transparent",
  };
  const filler: CSSProperties = {
    ...sectorEmptyCell,
    borderBottomColor: hasExpansion ? "transparent" : "var(--bg-border)",
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
          <span style={chevronStyle(expanded, "var(--color-accent)")}>
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
    borderBottomColor: hideBottom ? "transparent" : "var(--bg-border)",
  };
  const labelCell: CSSProperties = {
    ...subThemeLabelCell,
    borderBottomColor: hideBottom ? "transparent" : "var(--bg-border)",
  };
  const trailing: CSSProperties = {
    ...subThemeTrailingCell,
    borderBottomColor: hideBottom ? "transparent" : "var(--bg-border)",
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
          <span style={chevronStyle(expanded, "var(--text-secondary)")}>
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
  universeAsOf,
  selected,
  onSelectTicker,
}: {
  company: CompanyLeaf;
  position: RowPosition;
  metric: MetricKind;
  range: RangeMap;
  universeAsOf: string | null;
  selected: boolean;
  onSelectTicker: (ticker: string) => void;
}) {
  const isLast = position === "last" || position === "only";
  // A row is "stale" when its last bar is older than the universe min lastDate
  // (i.e. it's been left behind by the rest of the grid). We dim it so the
  // user can see at a glance which tickers are out of sync.
  const rowStale =
    !!company.lastDate &&
    !!universeAsOf &&
    company.lastDate < universeAsOf;
  // Amber selection tint matches the Factors-tab PerStockGrid selected-row
  // styling so the popup-source UX is identical across surfaces.
  const baseRow: CSSProperties = selected
    ? { ...companyRowStyle, background: SELECTED_ROW_BG }
    : companyRowStyle;
  const rowStyle: CSSProperties = rowStale
    ? { ...baseRow, opacity: 0.55, cursor: "pointer" }
    : { ...baseRow, cursor: "pointer" };
  const cellBg = selected ? SELECTED_ROW_BG : undefined;
  const sectorCell: CSSProperties = {
    ...companySectorCell,
    borderBottomColor: isLast ? "var(--bg-border)" : "transparent",
    ...(cellBg ? { background: cellBg } : {}),
  };
  const subCell: CSSProperties = {
    ...companySubCell,
    borderBottomColor: isLast ? "var(--bg-border)" : "transparent",
    ...(cellBg ? { background: cellBg } : {}),
  };
  const tickerCell: CSSProperties = {
    ...companyTickerCell,
    borderBottomColor: isLast ? "var(--bg-border)" : "transparent",
    ...(cellBg ? { background: cellBg } : {}),
  };
  const tickerTitle = rowStale && company.lastDate
    ? `${company.name} — last bar ${company.lastDate}, behind universe (click to open factor detail)`
    : `${company.name} (click to open factor detail)`;
  return (
    <tr
      style={rowStyle}
      onClick={() => onSelectTicker(company.ticker)}
      aria-selected={selected}
    >
      <td style={sectorCell} />
      <td style={subCell} />
      <td style={tickerCell}>
        <span style={tickerLine} title={tickerTitle}>
          <span style={companyNameText}>{company.name}</span>
          <span style={tickerSymbolText}>
            {company.ticker}
            {rowStale ? "*" : ""}
          </span>
        </span>
      </td>
      {HORIZON_ORDER.map((h) =>
        renderHeatCell(h, company.cells[h], metric, range[h], !isLast, "COMPANY")
      )}
    </tr>
  );
}

const SELECTED_ROW_BG = "rgba(240,182,93,0.10)";

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
        borderBottomColor: suppressBottom ? "transparent" : "var(--bg-border)",
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
      lastDate: r.lastDate ?? null,
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
  if (value == null || !Number.isFinite(value)) return "#0a0a0a";
  if (max <= min) return "#0a0a0a";
  let t = (value - min) / (max - min);
  if (metric === "VOLATILITY") t = 1 - t;
  const synthetic = t * 2 - 1;
  return heatmapRgb(synthetic, "RETURN", -1, 1);
}

function pickTextColor(bg: string): string {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(bg);
  if (!m) return "#ffffff";
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#000000" : "#ffffff";
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

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function calendarDaysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(
    Number(fromIso.slice(0, 4)),
    Number(fromIso.slice(5, 7)) - 1,
    Number(fromIso.slice(8, 10))
  );
  const b = Date.UTC(
    Number(toIso.slice(0, 4)),
    Number(toIso.slice(5, 7)) - 1,
    Number(toIso.slice(8, 10))
  );
  return Math.floor((b - a) / 86_400_000);
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
  gap: "6px",
  marginBottom: "6px",
  alignItems: "flex-end",
  lineHeight: 1.25,
};

const labelStyle: CSSProperties = {
  fontSize: "11px",
  color: "var(--text-secondary)",
  marginBottom: 2,
  lineHeight: 1.25,
  fontFamily:
    'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace',
};

const selectStyle: CSSProperties = {
  minWidth: "11rem",
  padding: "2px 6px",
  borderRadius: 0,
  border: "1px solid var(--chrome-border)",
  background: "var(--bg-surface)",
  color: "var(--text-primary)",
  fontSize: "12px",
  lineHeight: 1.25,
  fontFamily:
    'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace',
};

const legendText: CSSProperties = {
  fontSize: "11px",
  color: "var(--text-secondary)",
  marginBottom: "0.5rem",
  lineHeight: 1.25,
};

const tableWrap: CSSProperties = {
  overflowX: "auto",
  border: "1px solid var(--bg-border)",
  borderRadius: 0,
  background: "var(--bg-surface)",
};

const tableStyle: CSSProperties = {
  borderCollapse: "separate",
  borderSpacing: 0,
  width: "100%",
  fontSize: "12px",
  fontFamily:
    'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace',
};

const thStyle: CSSProperties = {
  padding: "2px 6px",
  borderBottom: "1px solid var(--bg-border)",
  background: "var(--bg-surface)",
  color: "var(--text-primary)",
  textAlign: "right",
  whiteSpace: "nowrap",
  fontWeight: 700,
  lineHeight: 1.25,
};

// Base styles for the label column cells. Borders use solid 1px lines whose
// colour is overridden per-row so we can hide seams within an expanded block
// while still drawing one at the bottom of each block. Per-level overrides
// below adjust padding (density) and background tint so sectors, sub-themes,
// and tickers each read as visually distinct horizontal bands.
const labelCellBase: CSSProperties = {
  borderBottom: "1px solid var(--bg-border)",
  whiteSpace: "nowrap",
  maxWidth: "20rem",
};

const tdCellStyle: CSSProperties = {
  borderBottom: "1px solid var(--bg-border)",
};

// Heat cells inherit the same vertical density as their row level so the
// table breathes (sector) → tightens (sub-theme) → compacts (ticker).
const HEAT_CELL_DENSITY: Record<
  LevelKey,
  { padding: string; fontSize: string; fontWeight: number }
> = {
  SECTOR: { padding: "0 6px", fontSize: "12px", fontWeight: 700 },
  SUB_THEME: { padding: "0 6px", fontSize: "12px", fontWeight: 500 },
  COMPANY: { padding: "0 6px", fontSize: "12px", fontWeight: 500 },
};

// === Sector row (warm amber, tall, uppercase) ===
const SECTOR_BG = "#0a0a0a";

const sectorRowStyle: CSSProperties = {
  background: SECTOR_BG,
};

const sectorLabelCell: CSSProperties = {
  ...labelCellBase,
  padding: "0 6px",
  background: SECTOR_BG,
};

const sectorEmptyCell: CSSProperties = {
  ...labelCellBase,
  padding: "0 6px",
  background: SECTOR_BG,
};

const sectorLabelText: CSSProperties = {
  color: "var(--color-accent)",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: "12px",
};

// === Sub-theme row (cool, mid-density, light text) ===
const SUB_THEME_BG = "#080808";

const subThemeRowStyle: CSSProperties = {
  background: SUB_THEME_BG,
};

const subThemeSectorCell: CSSProperties = {
  ...labelCellBase,
  padding: "0 6px",
  background: SUB_THEME_BG,
  // Continuous "spine" down the sector column ties every sub-theme back to
  // its parent sector visually.
  boxShadow: "inset 4px 0 0 #1a1a1a",
};

const subThemeLabelCell: CSSProperties = {
  ...labelCellBase,
  padding: "0 6px",
  paddingLeft: "12px",
  background: SUB_THEME_BG,
};

const subThemeTrailingCell: CSSProperties = {
  ...labelCellBase,
  padding: "0 6px",
  background: SUB_THEME_BG,
};

const subThemeLabelText: CSSProperties = {
  color: "#d0d0d0",
  fontWeight: 500,
  fontSize: "12px",
  letterSpacing: "0.005em",
};

// === Company row (compact, monospaced ticker, recessed) ===
const COMPANY_BG = "#050505";

const companyRowStyle: CSSProperties = {
  background: COMPANY_BG,
};

const companySectorCell: CSSProperties = {
  ...labelCellBase,
  padding: "0 6px",
  background: COMPANY_BG,
  // Sector spine continues through company rows so the whole sector reads as
  // one connected block.
  boxShadow: "inset 4px 0 0 #1a1a1a",
};

const companySubCell: CSSProperties = {
  ...labelCellBase,
  padding: "0 6px",
  background: COMPANY_BG,
  // Secondary spine through the sub-theme column groups companies under
  // their sub-theme parent.
  boxShadow: "inset 3px 0 0 #141414",
};

const companyTickerCell: CSSProperties = {
  ...labelCellBase,
  padding: "0 6px",
  paddingLeft: "16px",
  background: COMPANY_BG,
};

const tickerLine: CSSProperties = {
  display: "inline-flex",
  alignItems: "baseline",
  gap: "8px",
  maxWidth: "100%",
  overflow: "hidden",
};

const companyNameText: CSSProperties = {
  color: "var(--text-secondary)",
  fontWeight: 400,
  fontSize: "11px",
  maxWidth: "22ch",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const tickerSymbolText: CSSProperties = {
  color: "var(--text-primary)",
  fontWeight: 500,
  fontSize: "12px",
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "0.02em",
  fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
};

// === Gap row between sectors ===
const gapRowStyle: CSSProperties = {
  background: "#000000",
};

const gapCellStyle: CSSProperties = {
  height: 2,
  padding: 0,
  background: "#000000",
  borderBottom: "none",
};

const emptyStateCell: CSSProperties = {
  ...labelCellBase,
  background: "transparent",
};

const treeToggleBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  background: "transparent",
  border: "none",
  color: "inherit",
  font: "inherit",
  padding: 0,
  cursor: "pointer",
  textAlign: "left",
};

const btnGhost: CSSProperties = {
  padding: "1px 8px",
  borderRadius: 0,
  border: "1px solid var(--bg-border)",
  background: "var(--bg-base)",
  color: "var(--text-secondary)",
  fontSize: "11px",
  fontWeight: 500,
  cursor: "pointer",
};

const btnGhostActive: CSSProperties = {
  ...btnGhost,
  background: "var(--bg-elevated)",
  borderColor: "var(--color-accent)",
  color: "var(--text-primary)",
};

const extendedToggleWrap: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
};

const extendedToggleIdle: CSSProperties = {
  ...btnGhost,
  fontFamily:
    'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace',
};

function extendedToggleActive(session: MarketSession): CSSProperties {
  const accent =
    session === "PRE" ? "var(--color-accent)" : "#8b1f1f";
  return {
    ...btnGhost,
    borderColor: accent,
    color: accent,
    fontFamily:
      'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace',
  };
}

const extendedAsOf: CSSProperties = {
  fontSize: "11px",
  color: "var(--text-secondary)",
  fontFamily:
    'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace',
};
