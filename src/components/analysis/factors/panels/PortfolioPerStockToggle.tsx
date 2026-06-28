"use client";
import type { FactorView } from "@/store/analysis";

interface PortfolioPerStockToggleProps {
  value: FactorView;
  onChange: (v: FactorView) => void;
}

const OPTIONS: { value: FactorView; label: string }[] = [
  { value: "portfolio", label: "Portfolio" },
  { value: "per_stock", label: "Per stock" },
  { value: "correlations", label: "Factor correlations" },
  { value: "price_correlations", label: "Price correlations" },
];

export function PortfolioPerStockToggle({ value, onChange }: PortfolioPerStockToggleProps) {
  return (
    <div
      style={{
        display: "flex",
        gap: 0,
        borderBottom: "1px solid var(--bg-border)",
      }}
    >
      {OPTIONS.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              background: "transparent",
              border: "none",
              borderBottom: active ? "2px solid var(--color-accent)" : "2px solid transparent",
              color: active ? "var(--color-accent)" : "var(--text-secondary)",
              padding: "10px 18px 8px",
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
