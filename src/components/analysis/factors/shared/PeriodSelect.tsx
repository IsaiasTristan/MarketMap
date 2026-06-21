"use client";
import type { FactorPeriod } from "@/store/analysis";

const PERIODS: FactorPeriod[] = ["1D", "5D", "1M", "3M", "6M", "1Y"];

interface PeriodSelectProps {
  value: FactorPeriod;
  onChange: (v: FactorPeriod) => void;
}

export function PeriodSelect({ value, onChange }: PeriodSelectProps) {
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
      {PERIODS.map((p) => {
        const active = p === value;
        return (
          <button
            key={p}
            onClick={() => onChange(p)}
            style={{
              padding: "3px 10px",
              borderRadius: 5,
              border: `1px solid ${active ? "var(--color-accent)" : "var(--bg-border)"}`,
              background: active ? "var(--color-accent)" : "transparent",
              color: active ? "#fff" : "var(--text-secondary)",
              fontSize: 11,
              fontWeight: active ? 600 : 400,
              cursor: "pointer",
              transition: "all 0.12s",
            }}
          >
            {p}
          </button>
        );
      })}
    </div>
  );
}
