"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { ControlsBar } from "./panels/ControlsBar";
import { HeaderSummary } from "./panels/HeaderSummary";
import { ExposurePanel } from "./panels/ExposurePanel";
import { TimeSeriesPanel } from "./panels/TimeSeriesPanel";
import { DriversPanel } from "./panels/DriversPanel";
import { ScenariosPanel } from "./panels/ScenariosPanel";
import { RiskPanel } from "./panels/RiskPanel";
import { MarketContextPanel } from "./panels/MarketContextPanel";
import { AlertsPanel } from "./panels/AlertsPanel";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import type { FactorExposureSnapshot, AttributionResult, DriversResult, RiskDecomposition, FactorAlert } from "@/types/factors";

type Tab = "exposure" | "attribution" | "risk" | "drivers" | "scenarios" | "market" | "alerts";

const TABS: { key: Tab; label: string }[] = [
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
  const { activePortfolioId, factorModel, factorWindow, factorEwHalfLife, factorPeriod } =
    useAnalysisStore();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("exposure");
  const [driverGroupBy, setDriverGroupBy] = useState<"position" | "sector" | "subTheme">("sector");
  const [pipelineLoading, setPipelineLoading] = useState(false);

  const params = factorParams(factorModel, factorWindow, factorEwHalfLife);
  const baseUrl = `/api/analysis/factors`;

  // Exposure (always fetched)
  const { data: exposure, isLoading: exposureLoading, error: exposureError } = useQuery<FactorExposureSnapshot>({
    queryKey: ["factor-exposure", activePortfolioId, factorModel, factorWindow, factorEwHalfLife],
    queryFn: () =>
      fetch(`${baseUrl}/exposure?portfolioId=${activePortfolioId}&${params}`)
        .then((r) => r.json()),
    enabled: !!activePortfolioId,
    staleTime: 2 * 60_000,
  });

  // Attribution (tab)
  const { data: attribution, isLoading: attrLoading } = useQuery<AttributionResult>({
    queryKey: ["factor-attribution", activePortfolioId, factorModel, factorWindow],
    queryFn: () =>
      fetch(`${baseUrl}/attribution?portfolioId=${activePortfolioId}&${params}`)
        .then((r) => r.json()),
    enabled: !!activePortfolioId && (activeTab === "attribution" || activeTab === "exposure"),
    staleTime: 5 * 60_000,
  });

  // Exposure history (for time-series panel)
  const { data: history } = useQuery({
    queryKey: ["factor-history", activePortfolioId, factorModel],
    queryFn: () =>
      fetch(`${baseUrl}/exposure/history?portfolioId=${activePortfolioId}&model=${factorModel}`)
        .then((r) => r.json()),
    enabled: !!activePortfolioId && activeTab === "attribution",
    staleTime: 5 * 60_000,
  });

  // Risk (tab)
  const { data: risk } = useQuery<RiskDecomposition>({
    queryKey: ["factor-risk", activePortfolioId, factorModel, factorWindow],
    queryFn: () =>
      fetch(`${baseUrl}/risk?portfolioId=${activePortfolioId}&${params}`)
        .then((r) => r.json()),
    enabled: !!activePortfolioId && activeTab === "risk",
    staleTime: 5 * 60_000,
  });

  // Drivers (tab)
  const { data: drivers } = useQuery<DriversResult>({
    queryKey: ["factor-drivers", activePortfolioId, factorModel, factorWindow, driverGroupBy],
    queryFn: () =>
      fetch(`${baseUrl}/drivers?portfolioId=${activePortfolioId}&${params}&groupBy=${driverGroupBy}`)
        .then((r) => r.json()),
    enabled: !!activePortfolioId && activeTab === "drivers",
    staleTime: 5 * 60_000,
  });

  // Alerts (tab)
  const { data: alertsRaw } = useQuery<FactorAlert[]>({
    queryKey: ["factor-alerts", activePortfolioId],
    queryFn: () =>
      fetch(`${baseUrl}/alerts?portfolioId=${activePortfolioId}`)
        .then((r) => r.json()),
    enabled: !!activePortfolioId && activeTab === "alerts",
    staleTime: 60_000,
  });

  const alerts: FactorAlert[] = Array.isArray(alertsRaw) ? alertsRaw : [];

  async function handleRefreshPipeline() {
    setPipelineLoading(true);
    try {
      await fetch("/api/analysis/factors/pipeline-refresh", { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: ["factor-exposure"] });
      await queryClient.invalidateQueries({ queryKey: ["factor-attribution"] });
    } finally {
      setPipelineLoading(false);
    }
  }

  if (!activePortfolioId) {
    return (
      <div style={{ textAlign: "center", paddingTop: 80 }}>
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Select a portfolio to view factor analysis.
        </div>
      </div>
    );
  }

  const insufficientData =
    !exposureLoading &&
    exposureError === null &&
    exposure &&
    "error" in (exposure as Record<string, unknown>);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Page header */}
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Factor Analysis
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
          Institutional-grade factor exposure, attribution, and risk decomposition.
        </p>
      </div>

      {/* Controls */}
      <ControlsBar
        showPipeline
        onRefreshPipeline={handleRefreshPipeline}
        pipelineLoading={pipelineLoading}
      />

      {/* Insufficient data banner */}
      {insufficientData && (
        <div
          style={{
            padding: "10px 16px",
            background: "rgba(245,158,11,0.06)",
            border: "1px solid rgba(245,158,11,0.25)",
            borderRadius: 8,
            fontSize: 13,
            color: "var(--color-warning)",
          }}
        >
          Not enough data for factor regression. Need at least{" "}
          <strong>2k + 30 aligned trading days</strong> between your portfolio and the factor return
          series. Add positions or wait for more price history, then refresh the factor data pipeline.
        </div>
      )}

      {/* Header summary (always visible) */}
      {exposureLoading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
          {Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} height={80} />)}
        </div>
      ) : (
        <HeaderSummary
          exposure={exposure && !("error" in (exposure as Record<string, unknown>)) ? (exposure as FactorExposureSnapshot) : null}
          attribution={attribution}
          selectedPeriod={factorPeriod}
        />
      )}

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          gap: 2,
          borderBottom: "1px solid var(--bg-border)",
          paddingBottom: 0,
        }}
      >
        {TABS.map((t) => {
          const active = t.key === activeTab;
          return (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              style={{
                padding: "8px 14px",
                fontSize: 12,
                fontWeight: active ? 600 : 400,
                color: active ? "var(--color-accent)" : "var(--text-secondary)",
                background: "transparent",
                border: "none",
                borderBottom: active ? "2px solid var(--color-accent)" : "2px solid transparent",
                cursor: "pointer",
                marginBottom: -1,
                transition: "all 0.12s",
              }}
            >
              {t.label}
              {t.key === "alerts" && alerts.length > 0 && (
                <span
                  style={{
                    marginLeft: 5,
                    background: "var(--color-negative)",
                    color: "#fff",
                    fontSize: 9,
                    fontWeight: 700,
                    padding: "1px 5px",
                    borderRadius: 10,
                  }}
                >
                  {alerts.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === "exposure" && (
          <ExposurePanel
            exposure={exposure && !("error" in (exposure as Record<string, unknown>)) ? (exposure as FactorExposureSnapshot) : null}
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
    </div>
  );
}
