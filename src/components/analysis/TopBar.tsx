"use client";
import { useAnalysisStore, type DateRange } from "@/store/analysis";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

const DATE_RANGES: DateRange[] = ["1M", "3M", "6M", "1Y", "3Y", "ALL"];

export function TopBar() {
  const { activePortfolioId, dateRange, setDateRange } = useAnalysisStore();
  const [refreshing, setRefreshing] = useState(false);

  const { data: pnl } = useQuery<{
    totalValue: number;
    dailyPnl: number;
    dailyPnlPct: number;
    snapshotDate: string;
  }>({
    queryKey: ["pnl-summary", activePortfolioId],
    queryFn: async () => {
      if (!activePortfolioId) return null;
      const r = await fetch(
        `/api/analysis/portfolio/pnl?portfolioId=${activePortfolioId}`,
      );
      if (!r.ok) return null;
      const d = await r.json();
      // API returns { summary: { totalValue, dailyPnl, dailyPnlPct, snapshotDate, ... }, ... }
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

  // When the snapshot is from a prior trading day (e.g. Friday on a weekend),
  // show "as of Fri Apr 18" instead of just "Daily"
  const dailyLabel = (() => {
    if (!pnl?.snapshotDate || pnl.snapshotDate === todayIso) return "Daily";
    const d = new Date(pnl.snapshotDate + "T12:00:00"); // noon avoids timezone shift
    return `as of ${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`;
  })();

  return (
    <header
      style={{
        height: 56,
        background: "var(--bg-surface)",
        borderBottom: "1px solid var(--bg-border)",
        display: "flex",
        alignItems: "center",
        gap: 24,
        padding: "0 24px",
        flexShrink: 0,
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      {/* Total value */}
      {pnl ? (
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span
            style={{
              fontFamily: "var(--font-jetbrains-mono, monospace)",
              fontSize: 18,
              fontWeight: 700,
              color: "var(--text-primary)",
            }}
          >
            ${pnl.totalValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
            Total Value
          </span>
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          No portfolio selected
        </div>
      )}

      {/* Daily P&L */}
      {pnl && (
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            padding: "4px 10px",
            background: pnlPositive
              ? "rgba(34,197,94,0.1)"
              : "rgba(239,68,68,0.1)",
            borderRadius: 6,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-jetbrains-mono, monospace)",
              fontSize: 14,
              fontWeight: 700,
              color: pnlPositive ? "var(--color-positive)" : "var(--color-negative)",
            }}
          >
            {pnlPositive ? "+" : ""}
            {pnl.dailyPnlPct.toFixed(2)}%
          </span>
          <span
            style={{
              fontFamily: "var(--font-jetbrains-mono, monospace)",
              fontSize: 12,
              color: pnlPositive ? "var(--color-positive)" : "var(--color-negative)",
            }}
          >
            ({pnlPositive ? "+" : ""}$
            {Math.abs(pnl.dailyPnl).toLocaleString("en-US", {
              maximumFractionDigits: 0,
            })}
            )
          </span>
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{dailyLabel}</span>
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* Date */}
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{today}</span>

      {/* Date range */}
      <div style={{ display: "flex", gap: 2 }}>
        {DATE_RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setDateRange(r)}
            style={{
              padding: "3px 8px",
              borderRadius: 5,
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: r === dateRange ? 600 : 400,
              background: r === dateRange ? "var(--color-accent)" : "transparent",
              color:
                r === dateRange ? "#fff" : "var(--text-secondary)",
            }}
          >
            {r}
          </button>
        ))}
      </div>

      {/* Refresh button */}
      <button
        onClick={handleRefresh}
        disabled={refreshing || !activePortfolioId}
        style={{
          padding: "5px 12px",
          borderRadius: 6,
          border: "1px solid var(--bg-border)",
          background: "transparent",
          color: refreshing ? "var(--color-accent)" : "var(--text-secondary)",
          cursor: activePortfolioId ? "pointer" : "not-allowed",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <span
          style={{
            display: "inline-block",
            animation: refreshing ? "spin 1s linear infinite" : "none",
          }}
        >
          ↻
        </span>
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </header>
  );
}
