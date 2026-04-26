"use client";
/**
 * PerStockView — composes the per-stock grid with its sector/sub-theme
 * filter and metric toggle. Clicking a row opens a floating, draggable
 * `FloatingPerStockDetail` panel (up to 3 simultaneously). Lives behind
 * the "Per-stock" tab in `FactorsClient`.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { PerStockGrid } from "./PerStockGrid";
import { FloatingPerStockDetail } from "./FloatingPerStockDetail";
import { SectorSubThemeFilter } from "../shared/SectorSubThemeFilter";
import { MetricToggle } from "../shared/MetricToggle";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import type { PerStockResult } from "@/server/services/factor-per-stock.service";

export function PerStockView() {
  const {
    factorModel,
    factorWindow,
    factorGridMetric,
    openFactorDetailPanels,
    factorGridSectorFilter,
    factorGridSubThemeFilter,
    setFactorGridMetric,
    openFactorDetailPanel,
    closeFactorDetailPanel,
    setFactorGridSectorFilter,
    setFactorGridSubThemeFilter,
  } = useAnalysisStore();

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
    queryKey: ["factor-per-stock", factorModel, factorWindow],
    queryFn: () =>
      fetch(`/api/analysis/factors/per-stock?model=${factorModel}&window=${factorWindow}`).then(
        (r) => r.json(),
      ),
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Filter + metric controls */}
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "flex-end",
          flexWrap: "wrap",
          padding: "10px 14px",
          background: "var(--bg-surface)",
          border: "1px solid var(--bg-border)",
          borderRadius: 2,
        }}
      >
        <SectorSubThemeFilter
          sectors={sectors}
          subThemesBySector={subThemesBySector}
          selectedSector={factorGridSectorFilter}
          selectedSubTheme={factorGridSubThemeFilter}
          onSectorChange={setFactorGridSectorFilter}
          onSubThemeChange={setFactorGridSubThemeFilter}
        />
        <div style={{ flex: 1 }} />
        <MetricToggle value={factorGridMetric} onChange={setFactorGridMetric} />
      </div>

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
        openTickers={openTickers}
        onOpenTicker={openFactorDetailPanel}
        onCloseTicker={closeFactorDetailPanel}
      />
      {openFactorDetailPanels.map((panel) => (
        <FloatingPerStockDetail key={panel.ticker} panel={panel} data={filtered} />
      ))}

      {/* Footer summary */}
      <div
        style={{
          fontSize: 10,
          color: "var(--text-muted)",
          padding: "4px 4px 8px",
        }}
      >
        Showing {filtered.rows.length} stock{filtered.rows.length === 1 ? "" : "s"} ·{" "}
        {filtered.usableFactors.length} of {filtered.coverage.length} factors usable · window{" "}
        {filtered.windowUsed} trading days · as of {filtered.asOfDate}
        {filtered.skipped.length > 0 && ` · ${filtered.skipped.length} skipped (insufficient price history)`}
      </div>
    </div>
  );
}
