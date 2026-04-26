"use client";
import { useAnalysisStore } from "@/store/analysis";
import { ModelSelect } from "../shared/ModelSelect";
import { WindowSelect } from "../shared/WindowSelect";
import { PeriodSelect } from "../shared/PeriodSelect";
import { MODEL_PRESETS } from "@/lib/factors/definitions/model-presets";

interface ControlsBarProps {
  showPipeline?: boolean;
  onRefreshPipeline?: () => void;
  pipelineLoading?: boolean;
  /** Hide the attribution-period selector when not relevant (e.g. per-stock view). */
  hidePeriod?: boolean;
}

export function ControlsBar({
  showPipeline,
  onRefreshPipeline,
  pipelineLoading,
  hidePeriod,
}: ControlsBarProps) {
  const { factorModel, factorWindow, factorPeriod, setFactorModel, setFactorWindow, setFactorPeriod } =
    useAnalysisStore();
  const factorCount = MODEL_PRESETS[factorModel]?.factors.length ?? 0;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 20,
        padding: "12px 16px",
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        borderRadius: 2,
        flexWrap: "wrap",
      }}
    >
      <ModelSelect value={factorModel} onChange={setFactorModel} />
      <WindowSelect value={factorWindow} onChange={setFactorWindow} factorCount={factorCount} />

      {!hidePeriod && (
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
      )}
      {hidePeriod && <div style={{ flex: 1 }} />}

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
