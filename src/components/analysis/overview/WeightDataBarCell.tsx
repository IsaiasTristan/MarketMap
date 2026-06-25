"use client";

import { fmtWeightPct } from "@/components/analysis/overview/formatters";

interface WeightDataBarCellProps {
  /** Gross portfolio weight as a decimal (0–1). */
  weight: number;
  /** When false, render label only (e.g. footer rows). */
  showBar?: boolean;
}

export function WeightDataBarCell({ weight, showBar = true }: WeightDataBarCellProps) {
  const pct = Number.isFinite(weight)
    ? Math.min(100, Math.max(0, weight * 100))
    : 0;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
      }}
    >
      {showBar && pct > 0 && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${pct}%`,
            background: "var(--bb-weight-bar)",
            pointerEvents: "none",
          }}
        />
      )}
      <span
        className="bb-num"
        style={{
          position: "relative",
          zIndex: 1,
          padding: "0 6px",
          color: "#fff",
        }}
      >
        {fmtWeightPct(weight)}
      </span>
    </div>
  );
}
