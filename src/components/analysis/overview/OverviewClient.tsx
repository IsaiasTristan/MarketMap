"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { FloatingPerStockDetail } from "@/components/analysis/factors/panels/FloatingPerStockDetail";
import { MetricCard } from "@/components/analysis/ui/MetricCard";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import { ContributorsChart } from "@/components/analysis/overview/ContributorsChart";
import {
  CapitalAllocationCard,
  type AllocHorizon,
  type AllocView,
} from "@/components/analysis/overview/CapitalAllocationCard";
import { HoldingsDashboard } from "@/components/analysis/overview/HoldingsDashboard";
import { HoldingsRiskTable } from "@/components/analysis/overview/HoldingsRiskTable";
import { HoldingsLiveChartGrid } from "@/components/analysis/overview/HoldingsLiveChartGrid";
import { PortfolioFactorSummary } from "@/components/analysis/overview/PortfolioFactorSummary";
import { fmt$, fmtPct } from "@/components/analysis/overview/formatters";
import type { HoldingRow } from "@/server/services/portfolio-holdings.service";
import type { PerStockResult } from "@/server/services/factor-per-stock.service";
import type { PositionRisk } from "@/server/services/risk.service";
import type { FactorExposureSnapshot, AttributionResult } from "@/types/factors";

type PnlData = {
  summary: {
    totalValue: number;
    dailyPnl: number;
    dailyPnlPct: number;
    mtdPnl: number;
    mtdPnlPct: number;
    qtdPnl: number;
    qtdPnlPct: number;
    ytdPnl: number;
    ytdPnlPct: number;
    netValue: number;
  };
  positions: {
    ticker: string;
    dailyPnl: number;
    dailyPnlPct: number;
  }[];
  allocation: {
    byPosition: { name: string; value: number; pct: number }[];
    bySector: { name: string; value: number; pct: number }[];
  };
};

type ReturnRiskAlloc = {
  horizon: AllocHorizon;
  byReturn: {
    name: string;
    value: number;
    signed: number;
    negative: boolean;
    marketValue: number;
    dollar: number;
  }[];
  byRisk: {
    name: string;
    value: number;
    pct: number;
    dollar: number;
    negative: false;
    marketValue: number;
  }[];
  totals: {
    returnPct: number;
    returnDollar: number;
    varDollar: number;
    varPct: number;
    grossValue: number;
  };
};

export function OverviewClient() {
  const {
    activePortfolioId,
    factorModel,
    factorWindow,
    factorPeriod,
    openFactorDetailPanels,
    openFactorDetailPanel,
  } = useAnalysisStore();
  const [allocView, setAllocView] = useState<AllocView>("byPosition");
  const [horizon, setHorizon] = useState<AllocHorizon>("1D");

  const needsHorizonData = allocView === "byReturn" || allocView === "byRisk";

  const { data, isLoading, error } = useQuery<PnlData>({
    queryKey: ["pnl", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/portfolio/pnl?portfolioId=${activePortfolioId}`).then(
        (r) => r.json(),
      ),
    enabled: !!activePortfolioId,
    refetchInterval: 60_000,
  });

  const { data: rrAlloc } = useQuery<ReturnRiskAlloc>({
    queryKey: ["allocation", activePortfolioId, horizon],
    queryFn: () =>
      fetch(
        `/api/analysis/portfolio/allocation?portfolioId=${activePortfolioId}&horizon=${horizon}`,
      ).then((r) => r.json()),
    enabled: !!activePortfolioId && needsHorizonData,
    refetchInterval: 60_000,
  });

  const {
    data: holdingsData,
    isLoading: holdingsLoading,
    isError: holdingsError,
    error: holdingsFetchError,
  } = useQuery<{
    rows: HoldingRow[];
  }>({
    queryKey: ["holdings", activePortfolioId],
    queryFn: async () => {
      const r = await fetch(
        `/api/analysis/portfolio/holdings?portfolioId=${activePortfolioId}`,
      );
      const body = await r.json();
      if (!r.ok) {
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to load holdings",
        );
      }
      return body;
    },
    enabled: !!activePortfolioId,
    refetchInterval: 20_000,
  });

  const { data: posRiskData, isLoading: posRiskLoading } = useQuery<{
    positions: PositionRisk[];
    portfolioValue: number;
    portfolioTotal: PositionRisk | null;
  }>({
    queryKey: ["pos-risk", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/risk/position-risk?portfolioId=${activePortfolioId}`).then(
        (r) => r.json(),
      ),
    enabled: !!activePortfolioId,
    refetchInterval: 60_000,
  });

  const { data: exposure, isLoading: exposureLoading } = useQuery<FactorExposureSnapshot>({
    queryKey: ["factor-exposure-overview", activePortfolioId, factorWindow],
    queryFn: async () => {
      const r = await fetch(
        `/api/analysis/factors/exposure?portfolioId=${activePortfolioId}&model=MACRO14&window=${factorWindow}`,
      );
      if (!r.ok) return null;
      return r.json();
    },
    enabled: !!activePortfolioId,
    refetchInterval: 60_000,
  });

  const { data: attribution, isLoading: attributionLoading } = useQuery<AttributionResult | null>({
    queryKey: ["factor-attribution-overview", activePortfolioId, factorWindow],
    queryFn: async () => {
      const r = await fetch(
        `/api/analysis/factors/attribution?portfolioId=${activePortfolioId}&model=MACRO14&window=${factorWindow}`,
      );
      if (!r.ok) return null;
      return r.json();
    },
    enabled: !!activePortfolioId,
    refetchInterval: 60_000,
  });

  const { data: perStockData, isLoading: perStockLoading } = useQuery<PerStockResult>({
    queryKey: ["factor-per-stock", factorModel, factorWindow, factorPeriod],
    queryFn: () =>
      fetch(
        `/api/analysis/factors/per-stock?model=${factorModel}&window=${factorWindow}&period=${factorPeriod}`,
      ).then((r) => r.json()),
    enabled: openFactorDetailPanels.length > 0,
    staleTime: 5 * 60_000,
  });

  if (!activePortfolioId) {
    return (
      <div style={{ textAlign: "center", paddingTop: 80 }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>◈</div>
        <div style={{ fontSize: 16, color: "var(--text-secondary)", marginBottom: 12 }}>
          No portfolio selected
        </div>
        <a href="/data" style={{ color: "var(--color-accent)", fontSize: 13 }}>
          Go to Data Management →
        </a>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16 }}>
          {[0, 1, 2, 3].map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
        <SkeletonCard height={300} />
        <SkeletonCard height={400} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ color: "var(--color-negative)", padding: 24 }}>
        Failed to load portfolio data
      </div>
    );
  }

  const { summary, positions, allocation } = data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        <MetricCard
          label="Daily P&L"
          value={fmt$(summary.dailyPnl)}
          subValue={fmtPct(summary.dailyPnlPct)}
          valueColor={summary.dailyPnl >= 0 ? "positive" : "negative"}
        />
        <MetricCard
          label="MTD P&L"
          value={fmt$(summary.mtdPnl)}
          subValue={fmtPct(summary.mtdPnlPct)}
          valueColor={summary.mtdPnl >= 0 ? "positive" : "negative"}
        />
        <MetricCard
          label="QTD P&L"
          value={fmt$(summary.qtdPnl)}
          subValue={fmtPct(summary.qtdPnlPct)}
          valueColor={summary.qtdPnl >= 0 ? "positive" : "negative"}
        />
        <MetricCard
          label="YTD P&L"
          value={fmt$(summary.ytdPnl)}
          subValue={fmtPct(summary.ytdPnlPct)}
          valueColor={summary.ytdPnl >= 0 ? "positive" : "negative"}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "stretch" }}>
        <ContributorsChart positions={positions} />
        <CapitalAllocationCard
          totalValue={summary.totalValue}
          allocation={allocation}
          allocView={allocView}
          onAllocViewChange={setAllocView}
          horizon={horizon}
          onHorizonChange={setHorizon}
          rrAlloc={rrAlloc}
        />
      </div>

      <HoldingsDashboard
        rows={holdingsData?.rows ?? []}
        loading={holdingsLoading}
        error={
          holdingsError
            ? holdingsFetchError instanceof Error
              ? holdingsFetchError.message
              : "Failed to load holdings"
            : undefined
        }
        onNameClick={openFactorDetailPanel}
      />

      <HoldingsRiskTable
        positions={posRiskData?.positions ?? []}
        portfolioTotal={posRiskData?.portfolioTotal}
        dailyPnlByTicker={new Map(positions.map((p) => [p.ticker, p.dailyPnl]))}
        loading={posRiskLoading}
      />

      <HoldingsLiveChartGrid
        rows={holdingsData?.rows ?? []}
        dailyPnlByTicker={
          new Map(positions.map((p) => [p.ticker, p.dailyPnl]))
        }
        loading={holdingsLoading}
      />

      <PortfolioFactorSummary
        exposure={exposure}
        attribution={attribution}
        loading={exposureLoading || attributionLoading}
      />

      {perStockData &&
        openFactorDetailPanels.map((panel) => (
          <FloatingPerStockDetail
            key={panel.ticker}
            panel={panel}
            data={perStockData}
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
