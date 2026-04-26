"use client";
import type { FactorView } from "@/store/analysis";

interface PortfolioPerStockToggleProps {
  value: FactorView;
  onChange: (v: FactorView) => void;
}

const OPTIONS: { value: FactorView; label: string; sub: string }[] = [
  { value: "portfolio", label: "Portfolio", sub: "Aggregate factor decomposition" },
  { value: "per_stock", label: "Per-stock", sub: "Grid for every saved stock" },
  { value: "correlations", label: "Correlations", sub: "Factor × factor correlation matrix" },
];

export function PortfolioPerStockToggle({ value, onChange }: PortfolioPerStockToggleProps) {
  return (
    <div
      style={{
        display: "inline-flex",
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {OPTIONS.map((o, i) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              padding: "8px 18px",
              background: active ? "var(--bb-chrome)" : "transparent",
              color: active ? "#fff" : "var(--text-secondary)",
              border: "none",
              borderRight: i < OPTIONS.length - 1 ? "1px solid var(--bg-border)" : "none",
              cursor: "pointer",
              textAlign: "left",
              transition: "background 0.1s",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.05em" }}>{o.label}</div>
            <div
              style={{
                fontSize: 10,
                color: active ? "rgba(255,255,255,0.7)" : "var(--text-muted)",
                marginTop: 1,
              }}
            >
              {o.sub}
            </div>
          </button>
        );
      })}
    </div>
  );
}
