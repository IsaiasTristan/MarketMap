"use client";
/**
 * FactorToolbar — single-row, Bloomberg-tight toolbar for the Factors tab.
 *
 * Replaces three previously stacked rows (model+window, sector+sub-theme,
 * cell-metric) with one ~36px-tall bar of inline-labelled controls + two
 * segmented toggles (Metric, Stat) and a Refresh button.
 *
 * Combination guard: `risk` × (`t` | `ci`) is mathematically ill-defined
 * (PCR is non-linear in β). The buttons that would form that combination
 * are rendered disabled here, AND the store setters auto-snap if invoked
 * with the bad combo, so it can never be reached.
 */
import { useMemo, useRef, useState, useEffect } from "react";
import {
  useAnalysisStore,
  type FactorAttributionMode,
  type FactorGridStat,
  type FactorGridMetric,
  type FactorScreenerRefGroupKind,
} from "@/store/analysis";
import { PeriodSelect } from "./PeriodSelect";
import { InfoTooltip } from "@/components/analysis/ui/InfoTooltip";
import { HORIZON_PRESETS } from "@/lib/factors/definitions/horizon-presets";
import { Segmented } from "./Segmented";

interface FactorToolbarProps {
  /** Sectors derived from the data set being filtered (universe or holdings). */
  sectors: string[];
  /** Sub-theme list keyed by sector. */
  subThemesBySector: Record<string, string[]>;
  /** Hide the Stat toggle on views where it isn't relevant (portfolio aggregate, correlations). */
  hideStat?: boolean;
  /** Hide the Metric toggle (e.g. correlations view doesn't have factor cells). */
  hideMetric?: boolean;
  /** Hide the sector + sub-theme filters when the view doesn't filter by them. */
  hideFilters?: boolean;
  /** Hide the Window dropdown. */
  hideWindow?: boolean;
  /**
   * Show the Attribution Period selector immediately to the right of the
   * Window dropdown. Only relevant on the portfolio attribution view; the
   * per-stock grid and correlations views leave it off.
   */
  showPeriod?: boolean;
  /** Hide the Refresh button. */
  hideRefresh?: boolean;
  /** Hide the screener controls (sig gate, rank-vs). On per-stock view this is false. */
  hideScreener?: boolean;
  /** Hide the Attribution mode (log / simple) segmented control. */
  hideAttributionMode?: boolean;
  /** Refresh button — wired by the parent to invalidate factor queries. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Extra inline controls rendered to the left of the Refresh button (e.g. PeriodSelect). */
  trailing?: React.ReactNode;
}

const labelStyle: React.CSSProperties = {
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: 10,
  fontWeight: 600,
};

const selectStyle: React.CSSProperties = {
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  border: "1px solid var(--bg-border)",
  borderRadius: 2,
  padding: "0 8px",
  height: 26,
  fontSize: 11,
  cursor: "pointer",
  outline: "none",
  fontFamily: "inherit",
};

export function FactorToolbar({
  sectors,
  subThemesBySector,
  hideStat,
  hideMetric,
  hideFilters,
  hideWindow,
  showPeriod,
  hideRefresh,
  hideScreener,
  hideAttributionMode,
  onRefresh,
  refreshing,
  trailing,
}: FactorToolbarProps) {
  const {
    factorWindow,
    factorPeriod,
    factorGridMetric,
    factorGridStat,
    factorGridSectorFilter,
    factorGridSubThemeFilter,
    factorScreenerEnabled,
    factorScreenerFilters,
    factorScreenerRefGroup,
    factorAttributionMode,
    setFactorWindow,
    setFactorPeriod,
    setFactorGridMetric,
    setFactorGridStat,
    setFactorGridSectorFilter,
    setFactorGridSubThemeFilter,
    setFactorScreenerSigGate,
    setFactorScreenerRefGroup,
    setFactorAttributionMode,
    addToast,
  } = useAnalysisStore();
  const showScreener = !hideScreener && factorScreenerEnabled;

  const handleAttributionModeChange = (next: FactorAttributionMode) => {
    if (next === factorAttributionMode) return;
    setFactorAttributionMode(next);
    // Mode toggle reshuffles cohort stats / percentiles / heat — surface a
    // brief notice so users don't read the reshuffle as a bug. Same root
    // cause as the original Σα-disagreement issue, smaller scale.
    addToast({
      severity: "info",
      message: `Recomputing in ${next} space — Alpha / Unexplained rankings may shift.`,
    });
  };

  const subThemeOptions = useMemo(() => {
    if (!factorGridSectorFilter) {
      const all = new Set<string>();
      for (const list of Object.values(subThemesBySector)) for (const s of list) all.add(s);
      return [...all].sort();
    }
    return [...(subThemesBySector[factorGridSectorFilter] ?? [])].sort();
  }, [factorGridSectorFilter, subThemesBySector]);

  const isStatNonValue = factorGridStat === "t" || factorGridStat === "ci";
  const isMetricRisk = factorGridGuardActive(factorGridMetric);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
        height: 36,
        padding: "0 14px",
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        borderRadius: 2,
      }}
    >
      {(!hideWindow || showPeriod) && (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
          {!hideWindow && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={labelStyle}>Horizon</span>
              <Segmented<string>
                value={String(factorWindow)}
                onChange={(v) => setFactorWindow(Number(v) as typeof factorWindow)}
                options={HORIZON_PRESETS.map((p) => ({
                  value: String(p.value),
                  label: p.label,
                  title: `${p.sub} regression window (${p.value} trading days)`,
                }))}
              />
            </div>
          )}

          {showPeriod && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={labelStyle}>Attribution Period</span>
              <PeriodSelect value={factorPeriod} onChange={setFactorPeriod} />
            </div>
          )}

          <InfoTooltip
            name="Horizon vs Attribution Period"
            definition="Horizon sets the regression window (in trading days) used to estimate each factor beta — the model's training sample. Attribution Period is the trailing date range whose realized return is broken down into per-factor contributions using those betas. Horizon controls how the model is fit; Attribution Period controls what slice of history you're explaining. A shorter attribution period than the horizon is valid — stable betas fit on a long sample, applied to a recent slice."
          />
        </div>
      )}

      {!hideFilters && (
        <>
          <div
            style={{
              width: 1,
              height: 18,
              background: "var(--bg-border)",
            }}
            aria-hidden
          />

          <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={labelStyle}>Sector</span>
            <select
              value={factorGridSectorFilter ?? ""}
              onChange={(e) => setFactorGridSectorFilter(e.target.value || null)}
              style={{ ...selectStyle, minWidth: 130 }}
            >
              <option value="">All sectors</option>
              {sectors.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={labelStyle}>Sub-theme</span>
            <select
              value={factorGridSubThemeFilter ?? ""}
              onChange={(e) => setFactorGridSubThemeFilter(e.target.value || null)}
              style={{ ...selectStyle, minWidth: 130 }}
            >
              <option value="">All sub-themes</option>
              {subThemeOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <div style={{ flex: 1 }} />

      {!hideMetric && (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={labelStyle}>Metric</span>
          <Segmented<FactorGridMetric>
            value={factorGridMetric}
            onChange={setFactorGridMetric}
            options={[
              { value: "beta", label: "Beta" },
              { value: "return", label: "Return" },
              {
                value: "risk",
                label: "Risk",
                disabled: isStatNonValue,
                title: isStatNonValue
                  ? "Risk contribution does not pair with T or CI — switch Stat to Value first."
                  : "% of stock variance attributable to the factor",
              },
            ]}
          />
        </div>
      )}

      {!hideStat && (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={labelStyle}>Stat</span>
          <Segmented<FactorGridStat>
            value={factorGridStat}
            onChange={setFactorGridStat}
            options={[
              { value: "value", label: "Value" },
              {
                value: "t",
                label: "T",
                disabled: isMetricRisk,
                title: isMetricRisk
                  ? "T-stat is undefined for risk contributions — switch Metric to Beta or Return."
                  : "t-statistic for each cell",
              },
              {
                value: "ci",
                label: "CI",
                disabled: isMetricRisk,
                title: isMetricRisk
                  ? "CI is undefined for risk contributions — switch Metric to Beta or Return."
                  : "95% confidence interval half-width",
              },
              {
                value: "z",
                label: "Z",
                title:
                  "Z-score within the active reference group. Display clipped to ±5; falls back to percentile when the cohort is essentially constant.",
              },
              {
                value: "pct",
                label: "Pct",
                title:
                  "Percentile rank (1-99) within the active reference group. Min ranks at 1, max at 99.",
              },
            ]}
          />
        </div>
      )}

      {!hideAttributionMode && (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={labelStyle}>Attr</span>
          <Segmented<FactorAttributionMode>
            value={factorAttributionMode}
            onChange={handleAttributionModeChange}
            options={[
              {
                value: "log",
                label: "Log",
                title:
                  "Log-space attribution: Σ daily log α / log ε. Reconciles to compounded geometric realised return via exp(Σy_log)−1. Default — matches the per-stock waterfall's prominent Σ α_t (log) segment.",
              },
              {
                value: "simple",
                label: "Simple",
                title:
                  "Simple-return attribution: Σ daily simple α / simple ε. For high-vol stocks this disagrees with log-space by Jensen's inequality on each day's residual.",
              },
            ]}
          />
        </div>
      )}

      {showScreener && !hideStat && (
        <RankVsSelect
          kind={factorScreenerRefGroup.kind}
          onChange={(kind) =>
            setFactorScreenerRefGroup({ ...factorScreenerRefGroup, kind })
          }
        />
      )}

      {showScreener && (
        <SigGateChip
          enabled={factorScreenerFilters.sigGate.enabled}
          threshold={factorScreenerFilters.sigGate.threshold}
          onToggle={(enabled) => setFactorScreenerSigGate({ enabled })}
          onThreshold={(threshold) => setFactorScreenerSigGate({ threshold })}
        />
      )}

      {trailing}

      {onRefresh && !hideRefresh && (
        <button
          onClick={onRefresh}
          disabled={refreshing}
          style={{
            background: "transparent",
            border: "1px solid var(--bg-border)",
            color: refreshing ? "var(--text-muted)" : "var(--text-secondary)",
            borderRadius: 2,
            padding: "0 12px",
            height: 26,
            fontSize: 11,
            cursor: refreshing ? "default" : "pointer",
            fontFamily: "inherit",
            whiteSpace: "nowrap",
          }}
        >
          {refreshing ? "Refreshing…" : "↻ Refresh"}
        </button>
      )}
    </div>
  );
}

function factorGridGuardActive(metric: FactorGridMetric): boolean {
  return metric === "risk";
}

// ---------------------------------------------------------------------------
// Screener controls
// ---------------------------------------------------------------------------

interface RankVsSelectProps {
  kind: FactorScreenerRefGroupKind;
  onChange: (kind: FactorScreenerRefGroupKind) => void;
}

/**
 * "Rank vs:" dropdown selecting the cohort against which percentile, z-score,
 * and conditional-format heat are computed. Custom peer sets are not yet
 * surfaced (deferred to a later phase) but the type accepts the kind.
 */
function RankVsSelect({ kind, onChange }: RankVsSelectProps) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={labelStyle}>Rank vs</span>
      <select
        value={kind}
        onChange={(e) => onChange(e.target.value as FactorScreenerRefGroupKind)}
        style={{ ...selectStyle, minWidth: 120 }}
        title="Reference group used for percentile, z-score, and conditional-format heat."
      >
        <option value="universe">Universe</option>
        <option value="sector">Sector</option>
        <option value="subTheme">Sub-theme</option>
      </select>
    </div>
  );
}

interface SigGateChipProps {
  enabled: boolean;
  threshold: number;
  onToggle: (enabled: boolean) => void;
  onThreshold: (threshold: number) => void;
}

/**
 * Significance gate chip. Click to open a small popover with on/off toggle
 * and threshold input. When enabled the chip glows accent and the label
 * reads "|t| ≥ X.X"; when disabled it reads muted "Sig gate".
 */
function SigGateChip({
  enabled,
  threshold,
  onToggle,
  onThreshold,
}: SigGateChipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const label = enabled ? `|t| ≥ ${threshold.toFixed(1)}` : "Sig gate";

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          background: enabled ? "rgba(240,182,93,0.12)" : "transparent",
          border: `1px solid ${enabled ? "var(--color-accent)" : "var(--bg-border)"}`,
          color: enabled ? "var(--color-accent)" : "var(--text-secondary)",
          borderRadius: 2,
          padding: "0 10px",
          height: 26,
          fontSize: 11,
          fontWeight: enabled ? 700 : 500,
          letterSpacing: "0.04em",
          cursor: "pointer",
          fontFamily: "inherit",
          whiteSpace: "nowrap",
        }}
        title={
          enabled
            ? `Significance gate active: cells with |t| < ${threshold.toFixed(1)} render as "·" and are excluded from sort and cohort stats.`
            : "Significance gate. When on, masks low-|t| cells with a muted dot."
        }
      >
        {label}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: 30,
            right: 0,
            background: "var(--bg-elevated)",
            border: "1px solid var(--bg-border)",
            borderRadius: 2,
            padding: 12,
            minWidth: 220,
            zIndex: 50,
            boxShadow: "0 4px 18px rgba(0,0,0,0.45)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 10,
            }}
          >
            <input
              id="sig-gate-toggle"
              type="checkbox"
              checked={enabled}
              onChange={(e) => onToggle(e.target.checked)}
              style={{ accentColor: "var(--color-accent)" }}
            />
            <label
              htmlFor="sig-gate-toggle"
              style={{
                fontSize: 11,
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
            >
              Enable significance gate
            </label>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              opacity: enabled ? 1 : 0.5,
              pointerEvents: enabled ? "auto" : "none",
            }}
          >
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              |t| &ge;
            </span>
            <input
              type="number"
              value={threshold}
              min={0}
              step={0.1}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0) onThreshold(v);
              }}
              style={{
                width: 64,
                background: "var(--bg-surface)",
                color: "var(--text-primary)",
                border: "1px solid var(--bg-border)",
                borderRadius: 2,
                padding: "2px 6px",
                fontSize: 11,
                fontFamily: "inherit",
              }}
            />
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
              (1.96 ≈ 95 % CI)
            </span>
          </div>
          <div
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              marginTop: 10,
              lineHeight: 1.4,
            }}
          >
            Cells failing |t| ≥ threshold render as a muted &ldquo;·&rdquo;
            and are excluded from sort and cohort statistics. R² and Vol are
            never gated.
          </div>
        </div>
      )}
    </div>
  );
}
