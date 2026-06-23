"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { StockPriceChart } from "@/components/analysis/factors/panels/StockPriceChart";

export interface StockPriceChartModalProps {
  ticker: string;
  liveTail?: number[];
  onClose: () => void;
}

export function StockPriceChartModal({
  ticker,
  liveTail,
  onClose,
}: StockPriceChartModalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!mounted) return null;

  const node = (
    <div
      role="presentation"
      onClick={handleBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        role="dialog"
        aria-label={`${ticker} price chart`}
        style={{
          width: "100%",
          maxWidth: 720,
          background: "var(--bg-surface)",
          border: "1px solid var(--bg-border)",
          boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            background: "var(--bb-chrome)",
            color: "#fff",
            padding: "6px 12px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            height: 28,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, fontWeight: 700, letterSpacing: "0.05em" }}>
            {ticker}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "#fff",
              fontSize: 14,
              cursor: "pointer",
              padding: 0,
              lineHeight: 1,
            }}
            title="Close"
          >
            ✕
          </button>
        </div>
        <StockPriceChart
          ticker={ticker}
          live
          height={260}
          liveTail={liveTail}
          embedded
        />
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
