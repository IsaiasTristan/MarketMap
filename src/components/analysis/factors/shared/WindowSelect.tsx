"use client";
import type { FactorWindow } from "@/store/analysis";

const OPTIONS: { value: FactorWindow; label: string }[] = [
  { value: 20, label: "20D (1 Month)" },
  { value: 60, label: "60D (3 Months)" },
  { value: 120, label: "120D (6 Months)" },
  { value: 252, label: "252D (1 Year)" },
];

interface WindowSelectProps {
  value: FactorWindow;
  onChange: (v: FactorWindow) => void;
}

export function WindowSelect({ value, onChange }: WindowSelectProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        Window
      </label>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value) as FactorWindow)}
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--bg-border)",
          borderRadius: 6,
          color: "var(--text-primary)",
          fontSize: 12,
          padding: "4px 8px",
          cursor: "pointer",
          outline: "none",
        }}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
