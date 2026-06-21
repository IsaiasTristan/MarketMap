"use client";
/**
 * PerStockView — composes the per-stock grid with its sector/sub-theme
 * filter and metric toggle. Clicking a row opens a floating, draggable
 * `FloatingPerStockDetail` panel (up to 3 simultaneously). Lives behind
 * the "Per-stock" tab in `FactorsClient`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { PerStockGrid } from "./PerStockGrid";
import type { PerStockGridSort } from "./PerStockGrid";
import { FloatingPerStockDetail } from "./FloatingPerStockDetail";
import { SectorFactorHeatmap } from "./SectorFactorHeatmap";
import { FactorScatterPanel } from "./FactorScatterPanel";
import { FactorToolbar } from "../shared/FactorToolbar";
import { FilterChips } from "../shared/FilterChips";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import {
  aggregateBySectorFactor,
  applyRowFilters,
  sigGatePassed,
} from "@/lib/factors/screener";
import type { FactorCode } from "@/types/factors";
import type { PerStockResult } from "@/server/services/factor-per-stock.service";
import type { PrecomputeFreshness } from "@/lib/factors/diagnostics/precompute-freshness";
import type { RunnerState } from "@/server/services/precompute-runner";

interface PrecomputeStatusPayload {
  freshness: PrecomputeFreshness;
  runner: RunnerState;
}

export function PerStockView() {
  const {
    factorModel,
    factorWindow,
    factorPeriod,
    factorGridMetric,
    factorGridStat,
    openFactorDetailPanels,
    factorGridSectorFilter,
    factorGridSubThemeFilter,
    factorScreenerEnabled,
    factorScreenerFilters,
    factorSectorHeatmapEnabled,
    factorScatterEnabled,
    factorScatterPanelHeight,
    openFactorDetailPanel,
    closeFactorDetailPanel,
    setFactorScreenerEnabled,
    setFactorGridSectorFilter,
    setFactorScatterPanelHeight,
  } = useAnalysisStore();

  // Lifted from PerStockGrid so external triggers (sector × factor heatmap
  // cell click) can drive the grid's sort. The grid still owns the click
  // cycle; this holds the canonical sort state.
  const [sortBy, setSortBy] = useState<PerStockGridSort | null>(null);
  const [heatmapCollapsed, setHeatmapCollapsed] = useState(false);
  const [scatterCollapsed, setScatterCollapsed] = useState(false);
  // Brushed selection from the scatter panel — pinned to the top of the
  // grid above a divider when non-empty. Cleared by clicking an empty area
  // in the scatter (handled by FactorScatterPanel) or via its toolbar
  // "Clear" button.
  const [selectedTickers, setSelectedTickers] = useState<Set<string>>(
    () => new Set(),
  );
  const [rebuilding, setRebuilding] = useState(false);
  const queryClient = useQueryClient();

  // Precompute status — drives the freshness badge ("Last saved …" + green /
  // amber tint) and the "Refreshing…" state during a background catch-up.
  // Polls every 5s while a run is in flight; otherwise re-checks every 60s.
  const { data: precomputeStatus } = useQuery<PrecomputeStatusPayload>({
    queryKey: ["factor-precompute-status"],
    queryFn: () =>
      fetch("/api/analysis/factors/precompute-status").then((r) => r.json()),
    refetchInterval: (query) =>
      query.state.data?.runner?.status === "running" ? 5_000 : 60_000,
    staleTime: 0,
  });

  // When a background run flips from "running" -> "done", refresh the grids
  // so the UI shows the just-computed cache without a manual reload.
  const prevRunnerStatus = useRef<string | null>(null);
  useEffect(() => {
    const cur = precomputeStatus?.runner?.status ?? null;
    if (prevRunnerStatus.current === "running" && cur === "done") {
      queryClient.invalidateQueries({ queryKey: ["factor-per-stock"] });
      queryClient.invalidateQueries({ queryKey: ["factor-exposure"] });
      queryClient.invalidateQueries({ queryKey: ["factor-attribution"] });
      queryClient.invalidateQueries({ queryKey: ["factor-risk"] });
    }
    prevRunnerStatus.current = cur;
  }, [precomputeStatus?.runner?.status, queryClient]);

  const openTickers = useMemo(
    () => openFactorDetailPanels.map((p) => p.ticker),
    [openFactorDetailPanels],
  );

  // Fetch the full universe-wide grid (server returns all rows; we filter on
  // the client too so the dropdown options always reflect the full universe).
  // Sending the sector/subTheme filters to the server is a future optimisation
  // for very large universes — for the current single-universe screener the
  // client-side filter is fast enough and keeps the dropdowns populated.
  const { data, isLoading, error } = useQuery<PerStockResult>({
    queryKey: ["factor-per-stock", factorModel, factorWindow, factorPeriod],
    queryFn: () =>
      fetch(
        `/api/analysis/factors/per-stock?model=${factorModel}&window=${factorWindow}&period=${factorPeriod}`,
      ).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  const filtered: PerStockResult | null = useMemo(() => {
    if (!data || "error" in (data as unknown as Record<string, unknown>)) return null;
    if (!factorGridSectorFilter && !factorGridSubThemeFilter) return data;
    const rows = data.rows.filter((r) => {
      if (factorGridSectorFilter && r.sector.toLowerCase() !== factorGridSectorFilter.toLowerCase()) {
        return false;
      }
      if (factorGridSubThemeFilter && r.subTheme.toLowerCase() !== factorGridSubThemeFilter.toLowerCase()) {
        return false;
      }
      return true;
    });
    return { ...data, rows };
  }, [data, factorGridSectorFilter, factorGridSubThemeFilter]);

  // Build dropdown options from the *unfiltered* rows so users can always
  // navigate back to other sectors/sub-themes.
  const { sectors, subThemesBySector } = useMemo(() => {
    const sset = new Set<string>();
    const map: Record<string, Set<string>> = {};
    if (data && "rows" in (data as unknown as Record<string, unknown>)) {
      for (const r of data.rows) {
        sset.add(r.sector);
        if (!map[r.sector]) map[r.sector] = new Set();
        map[r.sector]!.add(r.subTheme);
      }
    }
    const subThemesBySector: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(map)) subThemesBySector[k] = [...v].sort();
    return { sectors: [...sset].sort(), subThemesBySector };
  }, [data]);

  // Sector × factor heatmap aggregation — operates on screener-filtered rows
  // but ignores the sector / sub-theme dropdown filters so the heatmap stays
  // a stable map of all sectors even when the user has drilled into one.
  // Computed BEFORE the early returns so the hook order stays stable across
  // loading / error / ready render passes (react-hooks/rules-of-hooks).
  const heatmapResult = useMemo(() => {
    if (!data || "error" in (data as unknown as Record<string, unknown>)) return null;
    if (!factorScreenerEnabled || !factorSectorHeatmapEnabled) return null;
    const allRows = (data as PerStockResult).rows;
    const factors = (data as PerStockResult).usableFactors;
    const surviving = factorScreenerEnabled
      ? applyRowFilters(allRows, factorScreenerFilters).surviving
      : allRows;
    return aggregateBySectorFactor({
      rows: surviving,
      factors,
      metric: factorGridMetric,
      filters: factorScreenerFilters,
    });
  }, [
    data,
    factorScreenerEnabled,
    factorSectorHeatmapEnabled,
    factorScreenerFilters,
    factorGridMetric,
  ]);

  if (isLoading) {
    return <SkeletonCard height={420} />;
  }
  if (error || !filtered) {
    const errMsg = data && "reason" in (data as unknown as Record<string, unknown>)
      ? String((data as unknown as { reason: string }).reason)
      : "Could not load per-stock factor data. Refresh the factor pipeline if this is the first load.";
    return (
      <div
        style={{
          padding: 24,
          background: "var(--bg-surface)",
          border: "1px solid var(--bg-border)",
          color: "var(--text-secondary)",
          fontSize: 13,
        }}
      >
        {errMsg}
      </div>
    );
  }

  const droppedCount = filtered.coverage.filter((c) => c.status !== "OK").length;

  async function handleRefresh() {
    await fetch("/api/analysis/factors/pipeline-refresh", { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["factor-per-stock"] });
  }

  async function handleRebuildCache() {
    setRebuilding(true);
    try {
      await fetch("/api/analysis/factors/per-stock/precompute", { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: ["factor-per-stock"] });
    } finally {
      setRebuilding(false);
    }
  }

  const runnerStatus = precomputeStatus?.runner?.status ?? null;
  const isRefreshing = runnerStatus === "running";
  const isStale = precomputeStatus?.freshness?.stale ?? false;
  const lastSavedISO =
    precomputeStatus?.freshness?.latestComputedAt ??
    precomputeStatus?.freshness?.freshestComputedAt ??
    null;
  const lastSavedLabel = lastSavedISO
    ? new Date(lastSavedISO).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "never";
  const badgeColor = isRefreshing
    ? "var(--color-accent, #f0b65d)"
    : isStale
      ? "var(--color-warning, #f59e0b)"
      : "var(--color-positive, #4ade80)";
  const badgeTitle = isRefreshing
    ? `Background refresh in progress (${precomputeStatus?.runner?.lastTrigger ?? "manual"}). Started ${precomputeStatus?.runner?.startedAt ? new Date(precomputeStatus.runner.startedAt).toLocaleTimeString() : "—"}.`
    : isStale
      ? `Saved regressions are older than the last trading close — a server-startup catch-up should already be running, or run "npm run job:daily".`
      : `Regressions are current to the last trading close (${precomputeStatus?.freshness?.lastTradingClose ? new Date(precomputeStatus.freshness.lastTradingClose).toLocaleString() : ""}).`;

  const cacheControls = (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span
        title={badgeTitle}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 10,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono, monospace)",
          whiteSpace: "nowrap",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: badgeColor,
            boxShadow: isRefreshing ? `0 0 6px ${badgeColor}` : "none",
            animation: isRefreshing ? "factor-pulse 1.6s ease-in-out infinite" : "none",
          }}
        />
        {isRefreshing
          ? `Refreshing… (${precomputeStatus?.runner?.lastTrigger === "startup-catchup" ? "startup catch-up" : "manual"})`
          : (
            <>
              Last saved {lastSavedLabel} · as of {filtered.asOfDate}
            </>
          )}
      </span>
      <button
        onClick={handleRebuildCache}
        disabled={rebuilding || isRefreshing}
        title={
          isRefreshing
            ? "A background refresh is already in progress."
            : "Recompute and cache the per-stock grid now (use after editing the ticker universe). Does not refresh prices or factors — run npm run job:daily for that."
        }
        style={{
          background: "transparent",
          border: "1px solid var(--bg-border)",
          color: rebuilding || isRefreshing ? "var(--text-muted)" : "var(--text-secondary)",
          borderRadius: 2,
          padding: "0 12px",
          height: 26,
          fontSize: 11,
          cursor: rebuilding || isRefreshing ? "default" : "pointer",
          fontFamily: "inherit",
          whiteSpace: "nowrap",
        }}
      >
        {rebuilding ? "Rebuilding…" : "Rebuild cache"}
      </button>
      <style>{`@keyframes factor-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }`}</style>
    </div>
  );

  // Screener summary numbers — surface filter impact in the footer so users
  // see how many rows + cells the screener is hiding without having to click
  // through the chips.
  const screenerSummary = (() => {
    if (!factorScreenerEnabled) {
      return {
        survivingCount: filtered.rows.length,
        droppedCount: 0,
        totalFactorCells: 0,
        gatedCellsCount: 0,
      };
    }
    const { surviving } = applyRowFilters(filtered.rows, factorScreenerFilters);
    let totalFactorCells = 0;
    let gatedCells = 0;
    for (const r of surviving) {
      for (const code of filtered.usableFactors) {
        if (!r.cells[code]) continue;
        totalFactorCells++;
        if (
          factorScreenerFilters.sigGate.enabled &&
          !sigGatePassed(r, code, factorScreenerFilters)
        ) {
          gatedCells++;
        }
      }
    }
    return {
      survivingCount: surviving.length,
      droppedCount: filtered.rows.length - surviving.length,
      totalFactorCells,
      gatedCellsCount: gatedCells,
    };
  })();
  const gatedPctText =
    screenerSummary.totalFactorCells > 0
      ? `${Math.round(
          (100 * screenerSummary.gatedCellsCount) / screenerSummary.totalFactorCells,
        )}%`
      : "0%";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <FactorToolbar
        sectors={sectors}
        subThemesBySector={subThemesBySector}
        showPeriod
        onRefresh={handleRefresh}
        trailing={cacheControls}
      />

      {factorScreenerEnabled && (
        <FilterChips availableFactors={filtered.usableFactors} />
      )}

      {factorScreenerEnabled && factorSectorHeatmapEnabled && heatmapResult && (
        <SectorFactorHeatmap
          result={heatmapResult}
          metric={factorGridMetric}
          activeSector={factorGridSectorFilter}
          collapsed={heatmapCollapsed}
          onToggleCollapsed={() => setHeatmapCollapsed((v) => !v)}
          onCellClick={(sector: string, code: FactorCode) => {
            // Filter the grid to the clicked sector and sort by the factor
            // descending so the user lands on the strongest exposures first.
            setFactorGridSectorFilter(sector);
            setSortBy({ key: code, dir: "desc" });
          }}
        />
      )}

      {/* Coverage banner */}
      {droppedCount > 0 && (
        <div
          style={{
            padding: "8px 14px",
            background: "rgba(245,158,11,0.06)",
            border: "1px solid rgba(245,158,11,0.25)",
            borderRadius: 2,
            fontSize: 11,
            color: "var(--color-warning, #f59e0b)",
          }}
        >
          {droppedCount} factor{droppedCount === 1 ? "" : "s"} dropped from regressions for the
          current window because of insufficient history. Hover the muted column headers in the
          grid for details.
        </div>
      )}

      {/* Grid (full width). Detail panels float over the page. */}
      <PerStockGrid
        data={filtered}
        metric={factorGridMetric}
        stat={factorGridStat}
        openTickers={openTickers}
        onOpenTicker={openFactorDetailPanel}
        onCloseTicker={closeFactorDetailPanel}
        sortBy={sortBy}
        onSortChange={setSortBy}
        selectedTickers={selectedTickers}
      />

      {factorScreenerEnabled && factorScatterEnabled && (
        <FactorScatterPanel
          data={filtered}
          survivingTickers={
            new Set(
              applyRowFilters(filtered.rows, factorScreenerFilters).surviving.map(
                (r) => r.ticker,
              ),
            )
          }
          selectedTickers={selectedTickers}
          onSelectionChange={setSelectedTickers}
          height={factorScatterPanelHeight}
          onHeightChange={setFactorScatterPanelHeight}
          collapsed={scatterCollapsed}
          onToggleCollapsed={() => setScatterCollapsed((v) => !v)}
        />
      )}
      {openFactorDetailPanels.map((panel) => (
        <FloatingPerStockDetail key={panel.ticker} panel={panel} data={filtered} />
      ))}

      {/* Footer summary */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 10,
          color: "var(--text-muted)",
          padding: "4px 4px 8px",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          {factorScreenerEnabled ? (
            <>
              Showing {screenerSummary.survivingCount} of {filtered.rows.length} stock
              {filtered.rows.length === 1 ? "" : "s"}
              {factorScreenerFilters.sigGate.enabled &&
                ` · ${gatedPctText} of factor cells gated (|t| < ${factorScreenerFilters.sigGate.threshold.toFixed(
                  1,
                )})`}
              {" · "}
            </>
          ) : (
            <>
              Showing {filtered.rows.length} stock
              {filtered.rows.length === 1 ? "" : "s"}
              {" · "}
            </>
          )}
          {filtered.usableFactors.length} of {filtered.coverage.length} factors usable · window{" "}
          {filtered.windowUsed} trading days · as of {filtered.asOfDate}
          {filtered.skipped.length > 0 &&
            ` · ${filtered.skipped.length} skipped (insufficient price history)`}
        </div>
        <button
          type="button"
          onClick={() => setFactorScreenerEnabled(!factorScreenerEnabled)}
          title={
            factorScreenerEnabled
              ? "Switch to the legacy per-column-span heat and disable screener filters / cohort ranking. The screener state is preserved."
              : "Enable the screener: row predicate filters, cohort-relative percentile / z-score, sig gate, and percentile-based heat."
          }
          style={{
            background: "transparent",
            border: "1px solid var(--bg-border)",
            color: factorScreenerEnabled
              ? "var(--text-secondary)"
              : "var(--text-muted)",
            borderRadius: 2,
            padding: "2px 10px",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            cursor: "pointer",
            fontFamily: "inherit",
            whiteSpace: "nowrap",
          }}
        >
          {factorScreenerEnabled ? "Screener: ON" : "Screener: OFF (Classic)"}
        </button>
      </div>
    </div>
  );
}
