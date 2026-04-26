"use client";
import { useState } from "react";
import type { FactorWindow } from "@/store/analysis";

/**
 * Window presets for the Factors tab. Values are in *trading days*; labels
 * use the user-facing calendar approximation. The min-window guidance comes
 * from the locked-in plan: full 14-factor model needs ≥180-day window
 * (≥126 trading days). Shorter windows are still selectable but will produce
 * very wide error bars; the controls bar will badge low-confidence runs.
 */
const PRESETS: { value: FactorWindow; label: string; tradingDays: number }[] = [
  { value: 21, label: "30 day", tradingDays: 21 },
  { value: 42, label: "60 day", tradingDays: 42 },
  { value: 63, label: "90 day", tradingDays: 63 },
  { value: 126, label: "180 day", tradingDays: 126 },
  { value: 252, label: "365 day", tradingDays: 252 },
  { value: 378, label: "1.5 year", tradingDays: 378 },
  { value: 504, label: "2 year", tradingDays: 504 },
  { value: 1260, label: "5 year", tradingDays: 1260 },
];

interface WindowSelectProps {
  value: FactorWindow;
  onChange: (v: FactorWindow) => void;
  /**
   * Number of factors active in the current model. Used to mark presets as
   * having low DOF (an info-only signal — we still let the user pick them).
   */
  factorCount?: number;
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--bg-border)",
  borderRadius: 6,
  color: "var(--text-primary)",
  fontSize: 12,
  padding: "4px 8px",
  cursor: "pointer",
  outline: "none",
};

export function WindowSelect({ value, onChange, factorCount }: WindowSelectProps) {
  const isPreset = PRESETS.some((p) => p.value === value);
  const [customMode, setCustomMode] = useState<boolean>(!isPreset);
  const [customValue, setCustomValue] = useState<string>(String(value));

  function handlePresetSelect(raw: string) {
    if (raw === "custom") {
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    onChange(Number(raw) as FactorWindow);
  }

  function commitCustom() {
    const n = Math.max(20, Math.min(2520, Math.round(Number(customValue) || 0)));
    onChange(n as FactorWindow);
  }

  // Confidence indicator — needs ≥2k+30 obs for stable t-stats.
  const minRequired = factorCount ? 2 * factorCount + 30 : 0;
  const lowConfidence = factorCount != null && Number(value) < minRequired;

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
        Window
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <select
          value={customMode ? "custom" : String(value)}
          onChange={(e) => handlePresetSelect(e.target.value)}
          style={inputStyle}
          title={
            lowConfidence
              ? `Low confidence: window of ${value}D < recommended ${minRequired} for ${factorCount} factors.`
              : undefined
          }
        >
          {PRESETS.map((p) => {
            const lc = factorCount != null && p.tradingDays < minRequired;
            return (
              <option key={p.value} value={p.value}>
                {p.label}
                {lc ? "  (low DOF)" : ""}
              </option>
            );
          })}
          <option value="custom">Custom…</option>
        </select>
        {customMode && (
          <>
            <input
              type="number"
              min={20}
              max={2520}
              step={1}
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
              onBlur={commitCustom}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitCustom();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              style={{ ...inputStyle, width: 80 }}
              placeholder="days"
            />
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>trading days</span>
          </>
        )}
        {lowConfidence && (
          <span
            title={`Window has < 2k+30 = ${minRequired} observations for ${factorCount} factors.`}
            style={{
              fontSize: 10,
              color: "var(--color-warning, #f59e0b)",
              border: "1px solid rgba(245,158,11,0.35)",
              padding: "1px 6px",
              borderRadius: 3,
              cursor: "help",
            }}
          >
            ⚠ low DOF
          </span>
        )}
      </div>
    </div>
  );
}
