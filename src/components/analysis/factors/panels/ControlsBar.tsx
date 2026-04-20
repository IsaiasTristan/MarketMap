"use client";
import { useAnalysisStore } from "@/store/analysis";
import { ModelSelect } from "../shared/ModelSelect";
import { WindowSelect } from "../shared/WindowSelect";
import { PeriodSelect } from "../shared/PeriodSelect";
import type { FactorModelPreset, FactorWindow, FactorPeriod } from "@/store/analysis";

interface ControlsBarProps {
  showPipeline?: boolean;
  onRefreshPipeline?: () => void;
  pipelineLoading?: boolean;
}

export function ControlsBar({
  showPipeline,
  onRefreshPipeline,
  pipelineLoading,
}: ControlsBarProps) {
  const { factorModel, factorWindow, factorPeriod, setFactorModel, setFactorWindow, setFactorPeriod } =
    useAnalysisStore();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 20,
        padding: "12px 16px",
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        borderRadius: 10,
        flexWrap: "wrap",
      }}
    >
      <ModelSelect value={factorModel} onChange={setFactorModel} />
      <WindowSelect value={factorWindow} onChange={setFactorWindow} />

      <div style={{ flex: 1, minWidth: 240 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: 4,
          }}
        >
          Attribution Period
        </div>
        <PeriodSelect value={factorPeriod} onChange={setFactorPeriod} />
      </div>

      {showPipeline && (
        <button
          onClick={onRefreshPipeline}
          disabled={pipelineLoading}
          style={{
            padding: "5px 14px",
            borderRadius: 6,
            border: "1px solid var(--bg-border)",
            background: "transparent",
            color: pipelineLoading ? "var(--text-muted)" : "var(--text-secondary)",
            fontSize: 12,
            cursor: pipelineLoading ? "default" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {pipelineLoading ? "Refreshing…" : "↻ Refresh Factor Data"}
        </button>
      )}
    </div>
  );
}
