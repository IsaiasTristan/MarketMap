"use client";

import { BloombergModuleTabs, isModulePathActive } from "@/components/analysis/BloombergModuleTabs";
import { useAnalysisStore } from "@/store/analysis";
import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const HIDE_DOLLARS_KEY = "marketmap-hide-nav";

function HiddenDollarsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 5.2C7.2 5.2 3.2 8.1 1.4 12c1.8 3.9 5.8 6.8 10.6 6.8s8.8-2.9 10.6-6.8C20.8 8.1 16.8 5.2 12 5.2zm0 2.2a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2zm0 2.1a2.5 2.5 0 1 0 .01 5 2.5 2.5 0 0 0-.01-5z"
      />
      <path
        d="M3.4 20.2 20.6 3.8"
        fill="none"
        stroke="var(--bg-base)"
        strokeWidth="4.2"
        strokeLinecap="round"
      />
      <path
        d="M3.4 20.2 20.6 3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TopBar() {
  const activePortfolioId = useAnalysisStore((s) => s.activePortfolioId);
  const [refreshing, setRefreshing] = useState(false);
  const [hideDollars, setHideDollars] = useState(false);
  const [dollarsReady, setDollarsReady] = useState(false);
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
      };
    },
    enabled: !!activePortfolioId,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    setHideDollars(window.localStorage.getItem(HIDE_DOLLARS_KEY) === "1");
    setDollarsReady(true);
  }, []);

  const toggleHideDollars = () => {
    setHideDollars((prev) => {
      const next = !prev;
      window.localStorage.setItem(HIDE_DOLLARS_KEY, next ? "1" : "0");
      return next;
    });
  };

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
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  // Stay masked until localStorage is read so a refresh cannot flash the balance.
  const maskDollars = !dollarsReady || hideDollars;

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
          <>
            <button
              type="button"
              onClick={toggleHideDollars}
              aria-pressed={hideDollars}
              aria-label={hideDollars ? "Show portfolio value" : "Hide portfolio value"}
              title={hideDollars ? "Show portfolio value" : "Hide portfolio value"}
              style={{
                width: 14,
                height: 14,
                padding: 0,
                border: "none",
                background: "var(--color-negative)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {maskDollars ? (
                <button
                  type="button"
                  onClick={toggleHideDollars}
                  aria-label="Show portfolio value"
                  title="Show portfolio value"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                  }}
                >
                  <HiddenDollarsIcon />
                </button>
              ) : (
                <span className="bb-num" style={{ fontSize: 12, fontWeight: 700 }}>
                  ${pnl.totalValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
              )}
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>NAV</span>
            </div>
          </>
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
              {(pnl.dailyPnlPct * 100).toFixed(2)}%
            </span>
            {!maskDollars && (
              <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10, color: "#fff" }}>
                ({pnlPositive ? "+" : ""}$
                {Math.abs(pnl.dailyPnl).toLocaleString("en-US", { maximumFractionDigits: 0 })})
              </span>
            )}
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
