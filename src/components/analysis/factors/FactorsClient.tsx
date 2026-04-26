"use client";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { MODEL_PRESET_NAMES as VISIBLE_MODELS } from "@/lib/factors/definitions/model-presets";
import { ControlsBar } from "./panels/ControlsBar";
import { HeaderSummary } from "./panels/HeaderSummary";
import { ExposurePanel } from "./panels/ExposurePanel";
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
import { BloombergTabStrip } from "@/components/analysis/BloombergTabStrip";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import type { FactorExposureSnapshot, AttributionResult, DriversResult, RiskDecomposition, FactorAlert } from "@/types/factors";

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

function factorParams(model: string, win: number, ew: number | null) {
  return `model=${model}&window=${win}${ew ? `&ew=${ew}` : ""}`;
}

export function FactorsClient() {
  const {
    activePortfolioId,
    factorModel,
    factorWindow,
    factorEwHalfLife,
    factorPeriod,
    factorView,
    setFactorView,
    setFactorModel,
  } = useAnalysisStore();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<PortfolioTab>("exposure");
  const [driverGroupBy, setDriverGroupBy] = useState<"position" | "sector" | "subTheme">("sector");
  const [pipelineLoading, setPipelineLoading] = useState(false);

  // Coerce persisted store values that point at a now-hidden model (e.g. a
  // user that previously selected Carhart-4) back to the default MACRO14, so
  // the Model dropdown never shows a stale unselectable option.
  useEffect(() => {
    if (!VISIBLE_MODELS.includes(factorModel)) {
      setFactorModel("MACRO14");
    }
  }, [factorModel, setFactorModel]);

  const params = factorParams(factorModel, factorWindow, factorEwHalfLife);
  const baseUrl = `/api/analysis/factors`;
  const portfolioEnabled = factorView === "portfolio" && !!activePortfolioId;

  // Exposure (always fetched in portfolio mode)
  const { data: exposure, isLoading: exposureLoading, error: exposureError } = useQuery<FactorExposureSnapshot>({
    queryKey: ["factor-exposure", activePortfolioId, factorModel, factorWindow, factorEwHalfLife],
    queryFn: () =>
      fetch(`${baseUrl}/exposure?portfolioId=${activePortfolioId}&${params}`)
        .then((r) => r.json()),
    enabled: portfolioEnabled,
    staleTime: 2 * 60_000,
  });

  // Attribution (tab)
  const { data: attribution } = useQuery<AttributionResult>({
    queryKey: ["factor-attribution", activePortfolioId, factorModel, factorWindow],
    queryFn: () =>
      fetch(`${baseUrl}/attribution?portfolioId=${activePortfolioId}&${params}`)
        .then((r) => r.json()),
    enabled: portfolioEnabled && (activeTab === "attribution" || activeTab === "exposure"),
    staleTime: 5 * 60_000,
  });

  // Exposure history (for time-series panel)
  const { data: history } = useQuery({
    queryKey: ["factor-history", activePortfolioId, factorModel],
    queryFn: () =>
      fetch(`${baseUrl}/exposure/history?portfolioId=${activePortfolioId}&model=${factorModel}`)
        .then((r) => r.json()),
    enabled: portfolioEnabled && activeTab === "attribution",
    staleTime: 5 * 60_000,
  });

  // Risk — always loaded in portfolio mode so the Total Risk waterfall above
  // the tabs can render before the user clicks into the Risk tab.
  const { data: risk } = useQuery<RiskDecomposition>({
    queryKey: ["factor-risk", activePortfolioId, factorModel, factorWindow],
    queryFn: () =>
      fetch(`${baseUrl}/risk?portfolioId=${activePortfolioId}&${params}`)
        .then((r) => r.json()),
    enabled: portfolioEnabled,
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

  const showPortfolioEmptyState = factorView === "portfolio" && !activePortfolioId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Page header */}
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Factor Analysis
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
          Macro + style factor exposure, attribution, and risk — for the portfolio in aggregate or
          for every saved stock individually.
        </p>
      </div>

      {/* Top-level Portfolio | Per-stock toggle */}
      <PortfolioPerStockToggle value={factorView} onChange={setFactorView} />

      {/* Controls */}
      <ControlsBar
        showPipeline
        onRefreshPipeline={handleRefreshPipeline}
        pipelineLoading={pipelineLoading}
        hidePeriod={factorView !== "portfolio"}
      />

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
          {insufficientData && (
            <div
              style={{
                padding: "10px 16px",
                background: "rgba(245,158,11,0.06)",
                border: "1px solid rgba(245,158,11,0.25)",
                borderRadius: 2,
                fontSize: 13,
                color: "var(--color-warning)",
              }}
            >
              Not enough data for factor regression. Need at least{" "}
              <strong>2k + 30 aligned trading days</strong> between your portfolio and the factor return
              series. Add positions or wait for more price history, then refresh the factor data pipeline.
            </div>
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
              <ExposurePanel
                exposure={exposure && !("error" in (exposure as unknown as Record<string, unknown>)) ? (exposure as FactorExposureSnapshot) : null}
                attribution={attribution}
                selectedPeriod={factorPeriod}
              />
            )}
            {activeTab === "attribution" && (
              <TimeSeriesPanel
                history={history as Parameters<typeof TimeSeriesPanel>[0]["history"]}
                attribution={attribution}
              />
            )}
            {activeTab === "risk" && <RiskPanel risk={risk} />}
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
        </>
      )}
    </div>
  );
}
