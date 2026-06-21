"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FactorCode } from "@/types/factors";

export type DateRange = "1M" | "3M" | "6M" | "1Y" | "3Y" | "ALL";
export type FactorModelPreset = "CAPM" | "FF3" | "CARHART4" | "FF5" | "EXTENDED" | "MACRO14";
/**
 * Regression window (the training sample) in trading days. Driven by the
 * HORIZON segmented control, which couples each preset to a fixed window so
 * the model is always fit on a statistically adequate sample:
 *   Short-Term = 90 day (63) · Standard = 365 day (252, default) ·
 *   Long-Term = 2 year (504) · Very Long-Term = 3 year (756).
 */
export type FactorWindow = 63 | 252 | 504 | 756;
/**
 * Attribution period options — the slice of realized return decomposed using
 * the betas estimated over the window. Decoupled from the window: a shorter
 * attribution period than the window is valid (stable betas fit on a long
 * sample, applied to a recent slice). Options are trailing horizons.
 */
export type FactorPeriod = "1D" | "5D" | "1M" | "3M" | "6M" | "1Y";
export type FactorTsRollingWindow = 30 | 60 | 90 | 252 | "match";

/** Top-level Factors-tab view (Portfolio aggregate vs per-stock grid vs correlations). */
export type FactorView = "portfolio" | "per_stock" | "correlations";

/** Active metric in the per-stock grid heatmap. */
export type FactorGridMetric = "beta" | "return" | "risk";

/**
 * What numeric the per-stock grid renders inside each cell + summary column.
 *   - `value`: the raw metric (β / return / risk for factor cells; Σα for
 *     alpha; Σε for residual). Default scan view.
 *   - `t`: the t-statistic associated with that value. Significance lens.
 *   - `ci`: the 95 % confidence interval half-width — same |t|-keyed heat
 *     ramp as `t` since |T| = |β| / (CI/1.96).
 *   - `z`: cohort-relative z-score (value − μ_cohort) / σ_cohort. Display
 *     clipped to ±5; falls back to percentile when σ_cohort is below the
 *     screener's σ-floor (effectively-constant cohort). See screener pipeline.
 *   - `pct`: cohort-relative percentile rank (integer 1-99 in display).
 *
 * `risk` × (`t` | `ci`) is mathematically ill-defined (PCR is non-linear in
 * β); the toolbar disables that combination so it can't be reached. Risk × Z
 * and Risk × Pct ARE well-defined (rank within cohort) so they remain
 * available.
 */
export type FactorGridStat = "value" | "t" | "ci" | "z" | "pct";

// ---------------------------------------------------------------------------
// Screener — filter, cohort, and gate state for the per-stock screener
// ---------------------------------------------------------------------------

/**
 * Reference group for cohort-relative computations (z-score, percentile,
 * conditional-format heat). Custom peer sets are deferred to a later phase
 * but the union accepts the kind so the dropdown shape stays stable.
 */
export type FactorScreenerRefGroupKind =
  | "universe"
  | "sector"
  | "subTheme"
  | "custom";

export interface FactorScreenerRefGroup {
  kind: FactorScreenerRefGroupKind;
  /** Custom peer set id when `kind === "custom"`. */
  customId?: string;
}

/**
 * Screener filter state. Each entry is a row predicate that excludes the row
 * from the rendered grid AND from cohort statistics (so the cohort the user
 * sees percentiles/z-scores ranked against matches the surviving rows).
 *
 * `sigGate` is special: it's a CELL mask, not a row predicate. When enabled,
 * cells with |t| < threshold render as a muted "·" and are excluded from
 * sort + cohort stats on those columns; the row itself is preserved.
 */
export interface FactorScreenerFilters {
  /** Significance gate — cell-level mask on |t|. */
  sigGate: { enabled: boolean; threshold: number };
  /** Minimum R² (0..1) for a row to be included. null = no filter. */
  minRSquared: number | null;
  /** Minimum number of regression observations for a row to be included. */
  minObservations: number | null;
  /** Minimum |annualised α| for a row to be included. Decimal (0.05 = 5%). */
  alphaMagnitudeFloor: number | null;
  /** Per-factor minimum |β| for a row to be included. */
  betaMagnitudeFloor: Partial<Record<FactorCode, number>>;
  /** When true, rows whose 95 % CI on α includes 0 are excluded. */
  alphaCiExcludesZero: boolean;
}

export const DEFAULT_FACTOR_SCREENER_FILTERS: FactorScreenerFilters = {
  sigGate: { enabled: false, threshold: 2.0 },
  minRSquared: null,
  minObservations: null,
  alphaMagnitudeFloor: null,
  betaMagnitudeFloor: {},
  alphaCiExcludesZero: false,
};

export const DEFAULT_FACTOR_SCREENER_REF_GROUP: FactorScreenerRefGroup = {
  kind: "universe",
};

/**
 * Attribution mode for the per-stock + portfolio cumulative panels.
 *   - `simple`: arithmetic sum of daily simple excess returns. Identity
 *     `Σy = Σ(β·r) + Σα + Σε` holds at the daily level but the cumulative
 *     sum does NOT equal compounded realised return.
 *   - `log`: log-space identity `Σ y_log = Σ(β·x_log) + Σα + Σε`. Headline
 *     uses `exp(Σ y_log) - 1` which reconciles to the compounded geometric
 *     realised excess for the visible window.
 */
export type FactorAttributionMode = "simple" | "log";

/**
 * One floating per-stock detail panel. Position/size are stored in CSS pixels
 * relative to the viewport. `z` is a monotonically increasing counter used
 * for stacking — the panel with the highest `z` renders on top.
 */
export interface FactorDetailPanel {
  ticker: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export const MAX_FACTOR_DETAIL_PANELS = 3;

interface AnalysisState {
  activePortfolioId: string | null;
  dateRange: DateRange;
  onboardingDone: boolean;
  toasts: Toast[];
  // Factor analysis settings (persisted)
  factorModel: FactorModelPreset;
  factorWindow: FactorWindow;
  factorEwHalfLife: number | null;
  factorPeriod: FactorPeriod;
  factorView: FactorView;
  factorGridMetric: FactorGridMetric;
  factorGridStat: FactorGridStat;
  factorTsRollingWindow: FactorTsRollingWindow;
  factorAttributionMode: FactorAttributionMode;
  openFactorDetailPanels: FactorDetailPanel[];
  factorGridSectorFilter: string | null;
  factorGridSubThemeFilter: string | null;

  // ----- Screener (Phase 1-4) -------------------------------------------
  /**
   * Master toggle for the screener UI. When `false` the per-stock view
   * renders in legacy mode (no filter chips, no Z/Pct stat options, raw
   * per-column-span heat). Defaults to `true` for the user; behind the
   * single-user app this is also the dogfood feature flag.
   */
  factorScreenerEnabled: boolean;
  /** Row predicate filters + cell-level sig gate. See {@link FactorScreenerFilters}. */
  factorScreenerFilters: FactorScreenerFilters;
  /** Cohort definition for percentile / z-score / conditional-format heat. */
  factorScreenerRefGroup: FactorScreenerRefGroup;
  /**
   * Sub-flag for the inline column-header distribution strip (Phase A of
   * UI additions). Independent of the master screener flag so we can ship
   * it to all users earlier than the larger features. Gated under
   * `factorScreenerEnabled` regardless — without the screener pipeline the
   * strip has no cohort to draw against.
   */
  factorHeaderHistogramEnabled: boolean;
  /**
   * Sub-flag for the sector × factor heatmap panel (Phase C of UI additions).
   * Default open above the per-stock grid; user can collapse. Gated under
   * `factorScreenerEnabled`.
   */
  factorSectorHeatmapEnabled: boolean;
  /**
   * Sub-flag for the scatter panel below the per-stock grid (Phase B of
   * UI additions). Gated under `factorScreenerEnabled`.
   */
  factorScatterEnabled: boolean;
  /**
   * Persisted scatter panel height in CSS pixels. The user can drag-resize
   * the panel divider; we snapshot the latest height so it survives reloads
   * and cross-device workflow. Clamped to [240, 800] at render time.
   */
  factorScatterPanelHeight: number;

  setActivePortfolio: (id: string | null) => void;
  setDateRange: (r: DateRange) => void;
  markOnboardingDone: () => void;
  addToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
  setFactorModel: (m: FactorModelPreset) => void;
  setFactorWindow: (w: FactorWindow) => void;
  setFactorEwHalfLife: (hl: number | null) => void;
  setFactorPeriod: (p: FactorPeriod) => void;
  setFactorView: (v: FactorView) => void;
  setFactorGridMetric: (m: FactorGridMetric) => void;
  setFactorGridStat: (s: FactorGridStat) => void;
  setFactorTsRollingWindow: (w: FactorTsRollingWindow) => void;
  setFactorAttributionMode: (m: FactorAttributionMode) => void;
  openFactorDetailPanel: (ticker: string) => void;
  closeFactorDetailPanel: (ticker: string) => void;
  moveFactorDetailPanel: (ticker: string, x: number, y: number) => void;
  resizeFactorDetailPanel: (ticker: string, w: number, h: number) => void;
  focusFactorDetailPanel: (ticker: string) => void;
  setFactorGridSectorFilter: (s: string | null) => void;
  setFactorGridSubThemeFilter: (s: string | null) => void;

  // ----- Screener actions -----------------------------------------------
  setFactorScreenerEnabled: (enabled: boolean) => void;
  setFactorScreenerFilters: (patch: Partial<FactorScreenerFilters>) => void;
  resetFactorScreenerFilters: () => void;
  setFactorScreenerSigGate: (
    patch: Partial<FactorScreenerFilters["sigGate"]>,
  ) => void;
  setFactorScreenerBetaMagnitudeFloor: (
    code: FactorCode,
    floor: number | null,
  ) => void;
  setFactorScreenerRefGroup: (group: FactorScreenerRefGroup) => void;
  setFactorHeaderHistogramEnabled: (enabled: boolean) => void;
  setFactorSectorHeatmapEnabled: (enabled: boolean) => void;
  setFactorScatterEnabled: (enabled: boolean) => void;
  setFactorScatterPanelHeight: (height: number) => void;
}

export interface Toast {
  id: string;
  message: string;
  severity: "info" | "success" | "warning" | "error";
}

function computeDefaultPanelPlacement(existing: FactorDetailPanel[]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const fallback = { vw: 1440, vh: 900 };
  const vw = typeof window !== "undefined" ? window.innerWidth : fallback.vw;
  const vh = typeof window !== "undefined" ? window.innerHeight : fallback.vh;
  const w = 480;
  const h = Math.min(720, vh - 80);
  let x = vw - w - 24;
  let y = 88;
  if (existing.length > 0) {
    const top = existing.reduce((a, b) => (a.z > b.z ? a : b));
    x = Math.min(top.x + 24, vw - w - 24);
    y = Math.min(top.y + 24, vh - h - 24);
  }
  return { x: Math.max(8, x), y: Math.max(8, y), w, h };
}

export const useAnalysisStore = create<AnalysisState>()(
  persist(
    (set) => ({
      activePortfolioId: null,
      dateRange: "1Y",
      onboardingDone: false,
      toasts: [],
      factorModel: "MACRO14",
      factorWindow: 252,
      factorEwHalfLife: null,
      factorPeriod: "1Y",
      factorView: "portfolio",
      factorGridMetric: "beta",
      factorGridStat: "value",
      factorTsRollingWindow: 60,
      factorAttributionMode: "log",
      openFactorDetailPanels: [],
      factorGridSectorFilter: null,
      factorGridSubThemeFilter: null,
      factorScreenerEnabled: true,
      factorScreenerFilters: DEFAULT_FACTOR_SCREENER_FILTERS,
      factorScreenerRefGroup: DEFAULT_FACTOR_SCREENER_REF_GROUP,
      factorHeaderHistogramEnabled: true,
      factorSectorHeatmapEnabled: true,
      factorScatterEnabled: true,
      factorScatterPanelHeight: 380,
      setActivePortfolio: (id) => set({ activePortfolioId: id }),
      setDateRange: (dateRange) => set({ dateRange }),
      markOnboardingDone: () => set({ onboardingDone: true }),
      addToast: (t) =>
        set((s) => ({
          toasts: [...s.toasts, { ...t, id: crypto.randomUUID() }],
        })),
      dismissToast: (id) =>
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      setFactorModel: (factorModel) => set({ factorModel }),
      setFactorWindow: (factorWindow) => set({ factorWindow }),
      setFactorEwHalfLife: (factorEwHalfLife) => set({ factorEwHalfLife }),
      setFactorPeriod: (factorPeriod) => set({ factorPeriod }),
      setFactorView: (factorView) => set({ factorView }),
      setFactorGridMetric: (factorGridMetric) =>
        // Risk × T/CI is ill-defined — auto-flip Stat back to Value when the
        // user picks Risk, so the toolbar can never persist an invalid combo.
        set((s) =>
          factorGridMetric === "risk" && s.factorGridStat !== "value"
            ? { factorGridMetric, factorGridStat: "value" }
            : { factorGridMetric },
        ),
      setFactorGridStat: (factorGridStat) =>
        // Symmetric guard: Stat=T/CI snaps Metric off Risk if it was selected.
        set((s) =>
          (factorGridStat === "t" || factorGridStat === "ci") &&
          s.factorGridMetric === "risk"
            ? { factorGridStat, factorGridMetric: "beta" }
            : { factorGridStat },
        ),
      setFactorTsRollingWindow: (factorTsRollingWindow) => set({ factorTsRollingWindow }),
      setFactorAttributionMode: (factorAttributionMode) => set({ factorAttributionMode }),
      openFactorDetailPanel: (ticker) =>
        set((s) => {
          const nextZ = s.openFactorDetailPanels.reduce((m, p) => Math.max(m, p.z), 0) + 1;
          const existingIdx = s.openFactorDetailPanels.findIndex((p) => p.ticker === ticker);
          if (existingIdx >= 0) {
            const next = s.openFactorDetailPanels.slice();
            next[existingIdx] = { ...next[existingIdx]!, z: nextZ };
            return { openFactorDetailPanels: next };
          }
          const placement = computeDefaultPanelPlacement(s.openFactorDetailPanels);
          let pool = s.openFactorDetailPanels;
          if (pool.length >= MAX_FACTOR_DETAIL_PANELS) {
            // Drop the lowest-z (oldest-focused) panel.
            const oldest = pool.reduce((a, b) => (a.z < b.z ? a : b));
            pool = pool.filter((p) => p.ticker !== oldest.ticker);
          }
          return {
            openFactorDetailPanels: [...pool, { ticker, ...placement, z: nextZ }],
          };
        }),
      closeFactorDetailPanel: (ticker) =>
        set((s) => ({
          openFactorDetailPanels: s.openFactorDetailPanels.filter((p) => p.ticker !== ticker),
        })),
      moveFactorDetailPanel: (ticker, x, y) =>
        set((s) => ({
          openFactorDetailPanels: s.openFactorDetailPanels.map((p) =>
            p.ticker === ticker ? { ...p, x, y } : p,
          ),
        })),
      resizeFactorDetailPanel: (ticker, w, h) =>
        set((s) => ({
          openFactorDetailPanels: s.openFactorDetailPanels.map((p) =>
            p.ticker === ticker ? { ...p, w, h } : p,
          ),
        })),
      focusFactorDetailPanel: (ticker) =>
        set((s) => {
          const idx = s.openFactorDetailPanels.findIndex((p) => p.ticker === ticker);
          if (idx < 0) return s;
          const top = s.openFactorDetailPanels.reduce((m, p) => Math.max(m, p.z), 0);
          if (s.openFactorDetailPanels[idx]!.z === top) return s;
          const next = s.openFactorDetailPanels.slice();
          next[idx] = { ...next[idx]!, z: top + 1 };
          return { openFactorDetailPanels: next };
        }),
      setFactorGridSectorFilter: (factorGridSectorFilter) =>
        set({ factorGridSectorFilter, factorGridSubThemeFilter: null }),
      setFactorGridSubThemeFilter: (factorGridSubThemeFilter) =>
        set({ factorGridSubThemeFilter }),
      setFactorScreenerEnabled: (factorScreenerEnabled) =>
        set({ factorScreenerEnabled }),
      setFactorScreenerFilters: (patch) =>
        set((s) => ({
          factorScreenerFilters: { ...s.factorScreenerFilters, ...patch },
        })),
      resetFactorScreenerFilters: () =>
        set({ factorScreenerFilters: DEFAULT_FACTOR_SCREENER_FILTERS }),
      setFactorScreenerSigGate: (patch) =>
        set((s) => ({
          factorScreenerFilters: {
            ...s.factorScreenerFilters,
            sigGate: { ...s.factorScreenerFilters.sigGate, ...patch },
          },
        })),
      setFactorScreenerBetaMagnitudeFloor: (code, floor) =>
        set((s) => {
          const next = { ...s.factorScreenerFilters.betaMagnitudeFloor };
          if (floor === null || !Number.isFinite(floor)) {
            delete next[code];
          } else {
            next[code] = floor;
          }
          return {
            factorScreenerFilters: {
              ...s.factorScreenerFilters,
              betaMagnitudeFloor: next,
            },
          };
        }),
      setFactorScreenerRefGroup: (factorScreenerRefGroup) =>
        set({ factorScreenerRefGroup }),
      setFactorHeaderHistogramEnabled: (factorHeaderHistogramEnabled) =>
        set({ factorHeaderHistogramEnabled }),
      setFactorSectorHeatmapEnabled: (factorSectorHeatmapEnabled) =>
        set({ factorSectorHeatmapEnabled }),
      setFactorScatterEnabled: (factorScatterEnabled) =>
        set({ factorScatterEnabled }),
      setFactorScatterPanelHeight: (factorScatterPanelHeight) =>
        set({
          factorScatterPanelHeight: Math.max(240, Math.min(800, factorScatterPanelHeight)),
        }),
    }),
    {
      name: "analysis-store",
      // v2 (2026-04-26): default factorAttributionMode flipped from "simple" to
      // "log" so the per-stock + portfolio attribution headlines reconcile to
      // compounded geometric realised excess via exp(Σ y_log) − 1. Bumping the
      // version drops any persisted "simple" entry from prior sessions.
      // v3 (2026-04-26): default factor window is 378 trading days (~1.5 calendar
      // years). Migrate prior sessions still on the old 252d default.
      // v4 (2026-04-26): per-stock detail is now a floating draggable panel and
      // supports up to 3 open at once. Drop the legacy single-ticker key.
      // v5 (2026-05-03): factorGridStat persisted alongside factorGridMetric so
      // the per-stock grid lens (Value / T / CI) survives reloads.
      // v6 (2026-05-03): screener state — factorScreenerEnabled,
      // factorScreenerFilters, factorScreenerRefGroup. FactorGridStat union
      // grew to include "z" and "pct"; old persisted "value" / "t" / "ci"
      // values keep working without modification.
      // v7 (2026-05-03): factorHeaderHistogramEnabled sub-flag (Phase A of
      // UI additions) gated under factorScreenerEnabled.
      // v8 (2026-05-03): factorSectorHeatmapEnabled sub-flag (Phase C of UI
      // additions) gated under factorScreenerEnabled.
      // v9 (2026-05-03): factorScatterEnabled + factorScatterPanelHeight
      // (Phase B of UI additions). Height persisted so resize survives
      // reloads and cross-device workflow.
      // v10 (2026-06-13): attribution periods trimmed to YTD/1.5Y/2Y/3Y.
      // Any persisted short period (1D/5D/MTD/QTD/1M/3M/6M/1Y/ITD) reseeds to
      // the new 1.5Y default.
      // v11 (2026-06-13): HORIZON presets — factorWindow constrained to
      // {63,252,504,756}; attribution periods switched to 1D/5D/1M/3M/6M/1Y.
      // Legacy windows reseed to 252 (Standard); legacy periods reseed to 1Y.
      version: 11,
      partialize: (s) => ({
        activePortfolioId: s.activePortfolioId,
        dateRange: s.dateRange,
        onboardingDone: s.onboardingDone,
        factorModel: s.factorModel,
        factorWindow: s.factorWindow,
        factorEwHalfLife: s.factorEwHalfLife,
        factorPeriod: s.factorPeriod,
        factorView: s.factorView,
        factorGridMetric: s.factorGridMetric,
        factorGridStat: s.factorGridStat,
        factorTsRollingWindow: s.factorTsRollingWindow,
        factorAttributionMode: s.factorAttributionMode,
        factorScreenerEnabled: s.factorScreenerEnabled,
        factorScreenerFilters: s.factorScreenerFilters,
        factorScreenerRefGroup: s.factorScreenerRefGroup,
        factorHeaderHistogramEnabled: s.factorHeaderHistogramEnabled,
        factorSectorHeatmapEnabled: s.factorSectorHeatmapEnabled,
        factorScatterEnabled: s.factorScatterEnabled,
        factorScatterPanelHeight: s.factorScatterPanelHeight,
      }),
      migrate: (persisted, version) => {
        if (!persisted || typeof persisted !== "object") return persisted;
        const next = { ...(persisted as Record<string, unknown>) };
        if (version < 2) {
          next.factorAttributionMode = "log";
        }
        if (version < 3 && next.factorWindow === 252) {
          next.factorWindow = 378;
        }
        if (version < 4) {
          delete next.factorGridSelectedTicker;
        }
        if (version < 5 && next.factorGridStat == null) {
          next.factorGridStat = "value";
        }
        if (version < 6) {
          // Initialise screener fields. Defaults match the in-code defaults
          // so a v5-state user lands on the screener UI on first load with
          // zero filters active and Universe ranking — same visible behavior
          // as before until they engage a control.
          if (next.factorScreenerEnabled == null) next.factorScreenerEnabled = true;
          if (next.factorScreenerFilters == null) {
            next.factorScreenerFilters = DEFAULT_FACTOR_SCREENER_FILTERS;
          }
          if (next.factorScreenerRefGroup == null) {
            next.factorScreenerRefGroup = DEFAULT_FACTOR_SCREENER_REF_GROUP;
          }
          // FactorGridStat union grew but old values stay valid; nothing to
          // rewrite here.
        }
        if (version < 7) {
          if (next.factorHeaderHistogramEnabled == null) {
            next.factorHeaderHistogramEnabled = true;
          }
        }
        if (version < 8) {
          if (next.factorSectorHeatmapEnabled == null) {
            next.factorSectorHeatmapEnabled = true;
          }
        }
        if (version < 9) {
          if (next.factorScatterEnabled == null) next.factorScatterEnabled = true;
          if (next.factorScatterPanelHeight == null) next.factorScatterPanelHeight = 380;
        }
        if (version < 10) {
          const validPeriods = ["YTD", "1.5Y", "2Y", "3Y"];
          if (!validPeriods.includes(next.factorPeriod as string)) {
            next.factorPeriod = "1.5Y";
          }
        }
        if (version < 11) {
          const validWindows = [63, 252, 504, 756];
          if (!validWindows.includes(next.factorWindow as number)) {
            next.factorWindow = 252;
          }
          const validPeriods = ["1D", "5D", "1M", "3M", "6M", "1Y"];
          if (!validPeriods.includes(next.factorPeriod as string)) {
            next.factorPeriod = "1Y";
          }
        }
        return next;
      },
    },
  ),
);
