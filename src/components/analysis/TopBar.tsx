"use client";

import { BloombergModuleTabs, isModulePathActive } from "@/components/analysis/BloombergModuleTabs";
import { useAnalysisStore } from "@/store/analysis";
import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useState } from "react";

export function TopBar() {
  const { activePortfolioId } = useAnalysisStore();
  const [refreshing, setRefreshing] = useState(false);
  const pathname = usePathname() ?? "";
  // Market Map has its own page-level refresh button that re-ingests the
  // universe + benchmark prices. The TopBar refresh hits a different endpoint
  // (portfolio holdings + benchmarks), so showing both reads as a duplicate
  // control. Hide the TopBar refresh on /market-map and let the page own it.
  const showRefresh = !isModulePathActive(pathname, "/market-map");

  const { data: pnl } = useQuery<{
    totalValue: number;
    dailyPnl: number;
    dailyPnlPct: number;
    snapshotDate: string;
  } | null>({
    queryKey: ["pnl-summary", activePortfolioId],
    queryFn: async () => {
      if (!activePortfolioId) return null;
      const r = await fetch(
        `/api/analysis/portfolio/pnl?portfolioId=${activePortfolioId}`,
      );
      if (!r.ok) return null;
      const d = await r.json();
      const s = d?.summary;
      if (!s || typeof s.totalValue !== "number") return null;
      return {
        totalValue: s.totalValue,
        dailyPnl: s.dailyPnl,
        dailyPnlPct: s.dailyPnlPct,
        snapshotDate: s.snapshotDate as string,
      };
    },
    enabled: !!activePortfolioId,
    refetchInterval: 60_000,
  });

  const handleRefresh = async () => {
    if (!activePortfolioId) return;
    setRefreshing(true);
    try {
      await fetch(
        `/api/analysis/data/refresh?portfolioId=${activePortfolioId}`,
        { method: "POST" },
      );
    } finally {
      setRefreshing(false);
    }
  };

  const pnlPositive = (pnl?.dailyPnl ?? 0) >= 0;
  const todayIso = new Date().toISOString().slice(0, 10);
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const dailyLabel = (() => {
    if (!pnl?.snapshotDate || pnl.snapshotDate === todayIso) return "Daily";
    const d = new Date(pnl.snapshotDate + "T12:00:00");
    return `as of ${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`;
  })();

  return (
    <header
      style={{
        flexShrink: 0,
        position: "sticky",
        top: 0,
        zIndex: 10,
        borderBottom: "1px solid var(--chrome-border)",
        background: "var(--bg-base)",
      }}
    >
      <div
        style={{
          minHeight: 26,
          background: "var(--bg-base)",
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 4px",
          borderTop: "1px solid var(--chrome-border)",
        }}
      >
        <div
          style={{
            display: "flex",
            minWidth: 0,
            maxWidth: "100%",
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
            flexShrink: 1,
          }}
        >
          <BloombergModuleTabs />
        </div>

        <div style={{ flex: 1, minWidth: 8 }} />

        {pnl ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span className="bb-num" style={{ fontSize: 12, fontWeight: 700 }}>
              ${pnl.totalValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>NAV</span>
          </div>
        ) : (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>No portfolio</span>
        )}

        {pnl && (
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 4,
              padding: "1px 6px",
              background: pnlPositive ? "var(--color-positive)" : "var(--color-negative)",
              border: "none",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 10,
                fontWeight: 700,
                color: "#fff",
              }}
            >
              {pnlPositive ? "+" : ""}
              {pnl.dailyPnlPct.toFixed(2)}%
            </span>
            <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10, color: "#fff" }}>
              ({pnlPositive ? "+" : ""}$
              {Math.abs(pnl.dailyPnl).toLocaleString("en-US", { maximumFractionDigits: 0 })})
            </span>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.85)" }}>{dailyLabel}</span>
          </div>
        )}

        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{today}</span>

        {showRefresh && (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || !activePortfolioId}
            style={{
              padding: "1px 8px",
              border: "1px solid var(--chrome-border)",
              background: "var(--bg-base)",
              color: refreshing ? "var(--color-accent)" : "var(--text-secondary)",
              cursor: activePortfolioId ? "pointer" : "not-allowed",
              fontSize: 11,
              fontFamily: "var(--font-sans, sans-serif)",
            }}
          >
            {refreshing ? "…" : "↻ Refresh"}
          </button>
        )}
      </div>
    </header>
  );
}
