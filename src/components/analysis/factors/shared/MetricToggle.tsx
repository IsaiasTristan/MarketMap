"use client";
import type { FactorGridMetric } from "@/store/analysis";

interface MetricToggleProps {
  value: FactorGridMetric;
  onChange: (m: FactorGridMetric) => void;
}

const OPTIONS: { value: FactorGridMetric; label: string; help: string }[] = [
  { value: "beta", label: "Beta", help: "Factor sensitivity (β)" },
  { value: "return", label: "Return", help: "β × cumulative factor return over the window" },
  { value: "risk", label: "Risk", help: "% of stock variance attributable to the factor" },
];

export function MetricToggle({ value, onChange }: MetricToggleProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Cell metric
      </label>
      <div
        style={{
          display: "inline-flex",
          background: "var(--bg-elevated)",
          border: "1px solid var(--bg-border)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        {OPTIONS.map((o, i) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              onClick={() => onChange(o.value)}
              title={o.help}
              style={{
                padding: "5px 12px",
                background: active ? "var(--bb-chrome)" : "transparent",
                color: active ? "#fff" : "var(--text-secondary)",
                border: "none",
                borderRight: i < OPTIONS.length - 1 ? "1px solid var(--bg-border)" : "none",
                fontSize: 11,
                fontWeight: active ? 700 : 500,
                cursor: "pointer",
                letterSpacing: "0.04em",
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
