"use client";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAnalysisStore, type FactorPeriod } from "@/store/analysis";
import { MODEL_PRESET_NAMES as VISIBLE_MODELS } from "@/lib/factors/definitions/model-presets";
import { FactorToolbar } from "./shared/FactorToolbar";
import { HeaderSummary } from "./panels/HeaderSummary";
import { TimeSeriesPanel } from "./panels/TimeSeriesPanel";
import { DriversPanel } from "./panels/DriversPanel";
import { ScenariosPanel } from "./panels/ScenariosPanel";
import { RiskPanel } from "./panels/RiskPanel";
import { MarketContextPanel } from "./panels/MarketContextPanel";
import { AlertsPanel } from "./panels/AlertsPanel";
import { PortfolioPerStockToggle } from "./panels/PortfolioPerStockToggle";
import { PerStockView } from "./panels/PerStockView";
import { CorrelationsView } from "./panels/CorrelationsView";
import { PortfolioTotalsPanel } from "./panels/PortfolioTotalsPanel";
import { PortfolioFactorGrid } from "./panels/PortfolioFactorGrid";
import { CoverageWarning } from "./panels/CoverageWarning";
import { FloatingPortfolioDetail } from "./panels/FloatingPortfolioDetail";
import { FloatingPerStockDetail } from "./panels/FloatingPerStockDetail";
import { BloombergTabStrip } from "@/components/analysis/BloombergTabStrip";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import type { FactorExposureSnapshot, AttributionResult, DriversResult, RiskDecomposition, FactorAlert } from "@/types/factors";
import type { PerStockResult } from "@/server/services/factor-per-stock.service";
import type { PortfolioWeight } from "@/server/services/portfolio.service";

type PortfolioTab = "exposure" | "attribution" | "risk" | "drivers" | "scenarios" | "market" | "alerts";

const PORTFOLIO_TABS: { key: PortfolioTab; label: string }[] = [
  { key: "exposure", label: "Exposure" },
  { key: "attribution", label: "Attribution" },
  { key: "risk", label: "Risk" },
  { key: "drivers", label: "Drivers" },
  { key: "scenarios", label: "Scenarios" },
  { key: "market", label: "Market Context" },
  { key: "alerts", label: "Alerts" },
];

function factorParams(model: string, win: number) {
  return `model=${model}&window=${win}`;
}

export function FactorsClient() {
  const activePortfolioId = useAnalysisStore((s) => s.activePortfolioId);
  const factorModel = useAnalysisStore((s) => s.factorModel);
  const factorWindow = useAnalysisStore((s) => s.factorWindow);
  const factorPeriod = useAnalysisStore((s) => s.factorPeriod);
  const factorRiskWindow = useAnalysisStore((s) => s.factorRiskWindow);
  const factorView = useAnalysisStore((s) => s.factorView);
  const factorGridMetric = useAnalysisStore((s) => s.factorGridMetric);
  const factorGridSectorFilter = useAnalysisStore((s) => s.factorGridSectorFilter);
  const factorGridSubThemeFilter = useAnalysisStore((s) => s.factorGridSubThemeFilter);
  const openFactorDetailPanels = useAnalysisStore((s) => s.openFactorDetailPanels);
  const setFactorView = useAnalysisStore((s) => s.setFactorView);
  const setFactorModel = useAnalysisStore((s) => s.setFactorModel);
  const setFactorGridMetric = useAnalysisStore((s) => s.setFactorGridMetric);
  const setFactorGridSectorFilter = useAnalysisStore((s) => s.setFactorGridSectorFilter);
  const setFactorGridSubThemeFilter = useAnalysisStore((s) => s.setFactorGridSubThemeFilter);
  const openFactorDetailPanel = useAnalysisStore((s) => s.openFactorDetailPanel);
  const closeFactorDetailPanel = useAnalysisStore((s) => s.closeFactorDetailPanel);
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<PortfolioTab>("exposure");
  const [driverGroupBy, setDriverGroupBy] = useState<"position" | "sector" | "subTheme">("sector");
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [portfolioDetailOpen, setPortfolioDetailOpen] = useState(false);

  // Coerce persisted store values that point at a now-hidden model (e.g. a
  // user that previously selected Carhart-4) back to the default MACRO14, so
  // the Model dropdown never shows a stale unselectable option.
  useEffect(() => {
    if (!VISIBLE_MODELS.includes(factorModel)) {
      setFactorModel("MACRO14");
    }
  }, [factorModel, setFactorModel]);

  const params = factorParams(factorModel, factorWindow);
  const baseUrl = `/api/analysis/factors`;
  const portfolioEnabled = factorView === "portfolio" && !!activePortfolioId;

  // Exposure (always fetched in portfolio mode)
  const { data: exposure, isLoading: exposureLoading, error: exposureError } = useQuery<FactorExposureSnapshot>({
    queryKey: ["factor-exposure", activePortfolioId, factorModel, factorWindow],
    queryFn: () =>
      fetch(`${baseUrl}/exposure?portfolioId=${activePortfolioId}&${params}`)
        .then((r) => r.json()),
    enabled: portfolioEnabled,
    staleTime: 2 * 60_000,
  });

  // Attribution — fetched for the whole portfolio view (the Total Return
  // decomposition panel + the Attribution Period selector sit above the tab
  // strip, so they need this regardless of the active sub-tab). A non-200
  // (e.g. 422 INSUFFICIENT_DATA when there isn't enough overlapping history
  // for the regression window) resolves to null instead of being stored as a
  // bogus AttributionResult, so the UI can fall back cleanly.
  const { data: attribution } = useQuery<AttributionResult | null>({
    queryKey: ["factor-attribution", activePortfolioId, factorModel, factorWindow],
    queryFn: () =>
      fetch(`${baseUrl}/attribution?portfolioId=${activePortfolioId}&${params}`).then((r) =>
        r.ok ? (r.json() as Promise<AttributionResult>) : null,
      ),
    enabled: portfolioEnabled,
    staleTime: 5 * 60_000,
  });

  // Rolling factor-beta history (for the time-series panel). Window-aware so
  // the rolling series matches the selected HORIZON; served cache-first from
  // the daily-precomputed FactorRollingBetaSnapshot.
  const { data: history } = useQuery({
    queryKey: ["factor-history", activePortfolioId, factorModel, factorWindow],
    queryFn: () =>
      fetch(
        `${baseUrl}/exposure/history?portfolioId=${activePortfolioId}&model=${factorModel}&window=${factorWindow}`,
      ).then((r) => r.json()),
    enabled: portfolioEnabled && activeTab === "attribution",
    staleTime: 5 * 60_000,
  });

  // Risk — always loaded in portfolio mode so the Total Risk waterfall above
  // the tabs can render before the user clicks into the Risk tab. A non-200
  // (403 not-owned, 422 INSUFFICIENT_DATA, etc.) resolves to null instead of
  // storing a bogus `{ error }` object, mirroring the attribution query above
  // so consumers fall back cleanly instead of crashing on `risk.factors`.
  const { data: risk } = useQuery<RiskDecomposition | null>({
    queryKey: ["factor-risk", activePortfolioId, factorModel, factorWindow],
    queryFn: () =>
      fetch(`${baseUrl}/risk?portfolioId=${activePortfolioId}&${params}`).then((r) =>
        r.ok ? (r.json() as Promise<RiskDecomposition>) : null,
      ),
    enabled: portfolioEnabled,
    staleTime: 5 * 60_000,
  });

  // Risk-tab-only: a separate fetch keyed on the user-selected Risk Window
  // (1M/6M/1Y/2Y/5Y in trading days). Decoupled from HORIZON so the variance
  // waterfall above the tabs + the Exposure / Attribution tabs all stay on
  // the HORIZON sample while the Risk tab re-estimates the Euler
  // decomposition over the user's chosen trailing window. Lazy — only fired
  // when the Risk tab is active. Resolves non-200 to null, matching the
  // primary risk query, so a recent IPO or insufficient history surfaces
  // through the CoverageWarning chip rather than throwing.
  const { data: riskWindowed } = useQuery<RiskDecomposition | null>({
    queryKey: ["factor-risk-window", activePortfolioId, factorModel, factorRiskWindow],
    queryFn: () =>
      fetch(
        `${baseUrl}/risk?portfolioId=${activePortfolioId}&model=${factorModel}&window=${factorRiskWindow}`,
      ).then((r) => (r.ok ? (r.json() as Promise<RiskDecomposition>) : null)),
    enabled: portfolioEnabled && activeTab === "risk",
    staleTime: 5 * 60_000,
  });

  // Drivers (tab)
  const { data: drivers } = useQuery<DriversResult>({
    queryKey: ["factor-drivers", activePortfolioId, factorModel, factorWindow, driverGroupBy],
    queryFn: () =>
      fetch(`${baseUrl}/drivers?portfolioId=${activePortfolioId}&${params}&groupBy=${driverGroupBy}`)
        .then((r) => r.json()),
    enabled: portfolioEnabled && activeTab === "drivers",
    staleTime: 5 * 60_000,
  });

  // Per-stock factor result + portfolio weights (powers the Exposure tab's
  // heatmap-style grid). Per-stock is cached across the rest of the app —
  // reusing the same query key so the cache is shared with PerStockView.
  const { data: perStockData } = useQuery<PerStockResult>({
    queryKey: ["factor-per-stock", factorModel, factorWindow, factorPeriod],
    queryFn: () =>
      fetch(
        `/api/analysis/factors/per-stock?model=${factorModel}&window=${factorWindow}&period=${factorPeriod}`,
      ).then((r) => r.json()),
    enabled: portfolioEnabled && activeTab === "exposure",
    staleTime: 5 * 60_000,
  });

  const { data: portfolioWeightsResp } = useQuery<{ weights: PortfolioWeight[] }>({
    queryKey: ["portfolio-weights", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/portfolio/weights?portfolioId=${activePortfolioId}`).then((r) => r.json()),
    enabled: portfolioEnabled,
    staleTime: 60_000,
  });
  const portfolioWeights: PortfolioWeight[] = portfolioWeightsResp?.weights ?? [];

  // Alerts (tab)
  const { data: alertsRaw } = useQuery<FactorAlert[]>({
    queryKey: ["factor-alerts", activePortfolioId],
    queryFn: () =>
      fetch(`${baseUrl}/alerts?portfolioId=${activePortfolioId}`)
        .then((r) => r.json()),
    enabled: portfolioEnabled && activeTab === "alerts",
    staleTime: 60_000,
  });

  const alerts: FactorAlert[] = Array.isArray(alertsRaw) ? alertsRaw : [];

  async function handleRefreshPipeline() {
    setPipelineLoading(true);
    try {
      await fetch("/api/analysis/factors/pipeline-refresh", { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: ["factor-exposure"] });
      await queryClient.invalidateQueries({ queryKey: ["factor-attribution"] });
      await queryClient.invalidateQueries({ queryKey: ["factor-per-stock"] });
    } finally {
      setPipelineLoading(false);
    }
  }

  const insufficientData =
    factorView === "portfolio" &&
    !exposureLoading &&
    exposureError === null &&
    exposure &&
    "error" in (exposure as unknown as Record<string, unknown>);

  // Coverage diagnostics ride on BOTH the success snapshot and the 422 error
  // body, so the warning chip can name the culprit holdings either way.
  const coverageDiag =
    (exposure as unknown as { coverage?: import("@/types/factors").PortfolioCoverageDiagnostics | null })
      ?.coverage ?? null;

  const showPortfolioEmptyState = factorView === "portfolio" && !activePortfolioId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Page header */}
      <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
        Factor Analysis
      </h1>

      {/* Top-level Portfolio | Per-stock toggle */}
      <PortfolioPerStockToggle value={factorView} onChange={setFactorView} />

      {/* Top-level controls — per-stock renders its own toolbar internally,
          so we only show the shared bar for portfolio + correlations. */}
      {factorView !== "per_stock" && (
        <FactorToolbar
          sectors={[]}
          subThemesBySector={{}}
          hideStat
          hideMetric
          hideFilters
          hideScreener
          showPeriod={factorView === "portfolio" && !showPortfolioEmptyState}
          onRefresh={handleRefreshPipeline}
          refreshing={pipelineLoading}
        />
      )}

      {/* Per-stock view */}
      {factorView === "per_stock" && <PerStockView />}

      {/* Correlations view */}
      {factorView === "correlations" && <CorrelationsView />}

      {/* Portfolio view (existing layout) */}
      {factorView === "portfolio" && showPortfolioEmptyState && (
        <div style={{ textAlign: "center", paddingTop: 40 }}>
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            Select a portfolio to view portfolio-level factor analysis. The Per-stock tab works
            without a portfolio.
          </div>
        </div>
      )}

      {factorView === "portfolio" && !showPortfolioEmptyState && (
        <>
          {(insufficientData || coverageDiag) && (
            <CoverageWarning coverage={coverageDiag} failed={!!insufficientData} />
          )}

          {exposureLoading ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
              {Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} height={80} />)}
            </div>
          ) : (
            <HeaderSummary
              exposure={exposure && !("error" in (exposure as unknown as Record<string, unknown>)) ? (exposure as FactorExposureSnapshot) : null}
              attribution={attribution}
              selectedPeriod={factorPeriod}
            />
          )}

          {/* Total Return / Total Risk waterfalls — always-visible portfolio
              decomposition above the tab strip. */}
          {!exposureLoading && (
            <PortfolioTotalsPanel
              exposure={exposure && !("error" in (exposure as unknown as Record<string, unknown>)) ? (exposure as FactorExposureSnapshot) : null}
              attribution={attribution}
              risk={risk}
              selectedPeriod={factorPeriod}
              regressionWindow={factorWindow}
            />
          )}

          <div style={{ borderBottom: "1px solid var(--bg-border)", marginBottom: 8 }}>
            <BloombergTabStrip
              tabs={PORTFOLIO_TABS.map((t) => ({
                key: t.key,
                label: t.label,
                badge: t.key === "alerts" ? alerts.length : undefined,
              }))}
              activeKey={activeTab}
              onChange={(k) => setActiveTab(k as PortfolioTab)}
            />
          </div>

          <div>
            {activeTab === "exposure" && (
              <PortfolioExposureGridSection
                perStock={perStockData}
                holdings={portfolioWeights}
                exposure={exposure && !("error" in (exposure as unknown as Record<string, unknown>)) ? (exposure as FactorExposureSnapshot) : null}
                attribution={attribution}
                selectedPeriod={factorPeriod}
                metric={factorGridMetric}
                sectorFilter={factorGridSectorFilter}
                subThemeFilter={factorGridSubThemeFilter}
                openTickers={openFactorDetailPanels.map((p) => p.ticker)}
                onOpenTicker={openFactorDetailPanel}
                onCloseTicker={closeFactorDetailPanel}
                onOpenPortfolioDetail={() => setPortfolioDetailOpen(true)}
              />
            )}
            {activeTab === "attribution" && (
              <TimeSeriesPanel
                history={history as Parameters<typeof TimeSeriesPanel>[0]["history"]}
                attribution={attribution}
              />
            )}
            {activeTab === "risk" && <RiskPanel risk={riskWindowed} />}
            {activeTab === "drivers" && (
              <DriversPanel
                drivers={drivers}
                groupBy={driverGroupBy}
                onGroupByChange={setDriverGroupBy}
              />
            )}
            {activeTab === "scenarios" && <ScenariosPanel />}
            {activeTab === "market" && <MarketContextPanel />}
            {activeTab === "alerts" && <AlertsPanel alerts={alerts} />}
          </div>

          {/* Floating per-stock detail panels triggered from the heatmap rows. */}
          {activeTab === "exposure" && perStockData &&
            openFactorDetailPanels.map((panel) => (
              <FloatingPerStockDetail key={panel.ticker} panel={panel} data={perStockData} />
            ))}

          {/* Floating portfolio-level detail triggered from the Total row. */}
          {portfolioDetailOpen && (
            <FloatingPortfolioDetail
              exposure={exposure && !("error" in (exposure as unknown as Record<string, unknown>)) ? (exposure as FactorExposureSnapshot) : null}
              attribution={attribution}
              risk={risk}
              history={history as Parameters<typeof TimeSeriesPanel>[0]["history"]}
              selectedPeriod={factorPeriod}
              regressionWindow={factorWindow}
              onClose={() => setPortfolioDetailOpen(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Composition shell for the Exposure tab — filter controls + metric toggle
 * above the heatmap grid. Sector / sub-theme dropdowns are scoped to the
 * portfolio's holdings only (not the universe), since this view is about
 * "what the user holds."
 */
interface PortfolioExposureGridSectionProps {
  perStock: PerStockResult | undefined;
  holdings: PortfolioWeight[];
  exposure: FactorExposureSnapshot | null;
  attribution: AttributionResult | null | undefined;
  selectedPeriod: FactorPeriod;
  metric: "beta" | "return" | "risk";
  sectorFilter: string | null;
  subThemeFilter: string | null;
  openTickers: string[];
  onOpenTicker: (t: string) => void;
  onCloseTicker: (t: string) => void;
  onOpenPortfolioDetail: () => void;
}

function PortfolioExposureGridSection({
  perStock,
  holdings,
  exposure,
  attribution,
  selectedPeriod,
  metric,
  sectorFilter,
  subThemeFilter,
  openTickers,
  onOpenTicker,
  onCloseTicker,
  onOpenPortfolioDetail,
}: PortfolioExposureGridSectionProps) {
  const factorGridStat = useAnalysisStore((s) => s.factorGridStat);
  // Empty / loading states.
  if (!perStock) {
    return <SkeletonCard height={420} />;
  }
  if ("error" in (perStock as unknown as Record<string, unknown>)) {
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
        Per-stock factor data unavailable. Refresh the factor pipeline to
        populate it.
      </div>
    );
  }

  // Build dropdown options from PORTFOLIO holdings only — not the full
  // universe. Per the user's design: only show sectors / sub-themes the
  // user actually holds.
  const heldTickers = new Set(holdings.map((h) => h.ticker.toUpperCase()));
  const heldRows = perStock.rows.filter((r) => heldTickers.has(r.ticker.toUpperCase()));
  const sectorSet = new Set<string>();
  const subThemeMap: Record<string, Set<string>> = {};
  for (const r of heldRows) {
    sectorSet.add(r.sector);
    if (!subThemeMap[r.sector]) subThemeMap[r.sector] = new Set();
    subThemeMap[r.sector]!.add(r.subTheme);
  }
  const sectors = [...sectorSet].sort();
  const subThemesBySector: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(subThemeMap)) subThemesBySector[k] = [...v].sort();

  // Filter holdings (not the per-stock universe) by sector / sub-theme so the
  // grid only renders rows that match.
  const matchingHoldings = holdings.filter((h) => {
    const row = perStock.rows.find((r) => r.ticker.toUpperCase() === h.ticker.toUpperCase());
    if (!row) return false;
    if (sectorFilter && row.sector.toLowerCase() !== sectorFilter.toLowerCase()) return false;
    if (subThemeFilter && row.subTheme.toLowerCase() !== subThemeFilter.toLowerCase()) return false;
    return true;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Tab-scoped controls — Model + Window already live in the page-level
          toolbar, so this row only needs the per-tab filters and Metric/Stat
          lens. Same component as PerStockView for visual + behavioural
          consistency. */}
      <FactorToolbar
        sectors={sectors}
        subThemesBySector={subThemesBySector}
        hideWindow
        hideRefresh
        hideScreener
      />

      <PortfolioFactorGrid
        data={perStock}
        holdings={matchingHoldings}
        exposure={exposure}
        attribution={attribution}
        selectedPeriod={selectedPeriod}
        metric={metric}
        stat={factorGridStat}
        openTickers={openTickers}
        onOpenTicker={onOpenTicker}
        onCloseTicker={onCloseTicker}
        onOpenPortfolioDetail={onOpenPortfolioDetail}
      />

      <div style={{ fontSize: 10, color: "var(--text-muted)", padding: "4px 4px 8px" }}>
        Showing {matchingHoldings.length} of {holdings.length} holdings ·{" "}
        {perStock.usableFactors.length} factors usable · regression window{" "}
        {perStock.windowUsed} trading days · as of {perStock.asOfDate}.
        Total row aggregates β / return contributions via signed weight (long +,
        short −); Risk / α / T / Vol / R² come from the portfolio-level OLS.
      </div>
    </div>
  );
}
