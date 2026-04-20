"use client";
import { MODEL_PRESET_NAMES, MODEL_PRESETS } from "@/lib/factors/definitions/model-presets";
import type { FactorModelPreset } from "@/store/analysis";

interface ModelSelectProps {
  value: FactorModelPreset;
  onChange: (v: FactorModelPreset) => void;
}

export function ModelSelect({ value, onChange }: ModelSelectProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        Model
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as FactorModelPreset)}
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
        {MODEL_PRESET_NAMES.map((name) => (
          <option key={name} value={name}>
            {MODEL_PRESETS[name].label}
          </option>
        ))}
      </select>
    </div>
  );
}
