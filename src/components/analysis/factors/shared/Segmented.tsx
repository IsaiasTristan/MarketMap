"use client";
import type React from "react";

/**
 * Small horizontal segmented control used across the Factors tab toolbars
 * (HORIZON, Metric, Stat, Attribution Mode, Risk Window, …). Extracted from
 * `FactorToolbar.tsx` so other surfaces (e.g. `RiskPanel`) can reuse the
 * same chrome without depending on the full toolbar.
 */
const segContainerStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "var(--bg-elevated)",
  border: "1px solid var(--bg-border)",
  borderRadius: 2,
  overflow: "hidden",
  height: 26,
};

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
  title?: string;
}

export interface SegmentedProps<V extends string> {
  value: V;
  onChange: (v: V) => void;
  options: SegmentedOption<V>[];
}

export function Segmented<V extends string>({ value, onChange, options }: SegmentedProps<V>) {
  return (
    <div style={segContainerStyle}>
      {options.map((o, i) => {
        const active = o.value === value;
        const disabled = !!o.disabled;
        return (
          <button
            key={o.value}
            onClick={() => !disabled && onChange(o.value)}
            title={o.title}
            disabled={disabled}
            style={{
              background: active && !disabled ? "var(--bb-chrome)" : "transparent",
              color: disabled
                ? "#3a3a3a"
                : active
                  ? "#fff"
                  : "var(--text-secondary)",
              border: "none",
              borderRight: i < options.length - 1 ? "1px solid var(--bg-border)" : "none",
              padding: "0 12px",
              height: "100%",
              fontSize: 11,
              fontWeight: active ? 700 : 500,
              letterSpacing: "0.04em",
              cursor: disabled ? "not-allowed" : "pointer",
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
