"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DateRange = "1M" | "3M" | "6M" | "1Y" | "3Y" | "ALL";
export type FactorModelPreset = "CAPM" | "FF3" | "CARHART4" | "FF5" | "EXTENDED" | "MACRO14";
/** Window in trading days. Presets map to ~calendar lookback windows. */
export type FactorWindow = 21 | 42 | 63 | 126 | 252 | 1260 | number;
export type FactorPeriod = "1D" | "5D" | "MTD" | "QTD" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "ITD";
export type FactorTsRollingWindow = 30 | 60 | 90 | 252 | "match";

/** Top-level Factors-tab view (Portfolio aggregate vs per-stock grid vs correlations). */
export type FactorView = "portfolio" | "per_stock" | "correlations";

/** Active metric in the per-stock grid heatmap. */
export type FactorGridMetric = "beta" | "return" | "risk";

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
  factorTsRollingWindow: FactorTsRollingWindow;
  factorAttributionMode: FactorAttributionMode;
  factorGridSelectedTicker: string | null;
  factorGridSectorFilter: string | null;
  factorGridSubThemeFilter: string | null;
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
  setFactorTsRollingWindow: (w: FactorTsRollingWindow) => void;
  setFactorAttributionMode: (m: FactorAttributionMode) => void;
  setFactorGridSelectedTicker: (t: string | null) => void;
  setFactorGridSectorFilter: (s: string | null) => void;
  setFactorGridSubThemeFilter: (s: string | null) => void;
}

export interface Toast {
  id: string;
  message: string;
  severity: "info" | "success" | "warning" | "error";
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
      factorTsRollingWindow: 60,
      factorAttributionMode: "log",
      factorGridSelectedTicker: null,
      factorGridSectorFilter: null,
      factorGridSubThemeFilter: null,
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
      setFactorGridMetric: (factorGridMetric) => set({ factorGridMetric }),
      setFactorTsRollingWindow: (factorTsRollingWindow) => set({ factorTsRollingWindow }),
      setFactorAttributionMode: (factorAttributionMode) => set({ factorAttributionMode }),
      setFactorGridSelectedTicker: (factorGridSelectedTicker) =>
        set({ factorGridSelectedTicker }),
      setFactorGridSectorFilter: (factorGridSectorFilter) =>
        set({ factorGridSectorFilter, factorGridSubThemeFilter: null }),
      setFactorGridSubThemeFilter: (factorGridSubThemeFilter) =>
        set({ factorGridSubThemeFilter }),
    }),
    {
      name: "analysis-store",
      // v2 (2026-04-26): default factorAttributionMode flipped from "simple" to
      // "log" so the per-stock + portfolio attribution headlines reconcile to
      // compounded geometric realised excess via exp(Σ y_log) − 1. Bumping the
      // version drops any persisted "simple" entry from prior sessions.
      version: 2,
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
        factorTsRollingWindow: s.factorTsRollingWindow,
        factorAttributionMode: s.factorAttributionMode,
      }),
      migrate: (persisted, version) => {
        if (!persisted || typeof persisted !== "object") return persisted;
        const next = { ...(persisted as Record<string, unknown>) };
        if (version < 2) {
          next.factorAttributionMode = "log";
        }
        return next;
      },
    },
  ),
);
