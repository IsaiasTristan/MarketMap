"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DateRange = "1M" | "3M" | "6M" | "1Y" | "3Y" | "ALL";
export type FactorModelPreset = "CAPM" | "FF3" | "CARHART4" | "FF5" | "EXTENDED" | "MACRO14";
/** Window in trading days. Presets map to ~calendar lookback windows. */
export type FactorWindow = 21 | 42 | 63 | 126 | 252 | 378 | 504 | 1260 | number;
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
  factorTsRollingWindow: FactorTsRollingWindow;
  factorAttributionMode: FactorAttributionMode;
  openFactorDetailPanels: FactorDetailPanel[];
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
  openFactorDetailPanel: (ticker: string) => void;
  closeFactorDetailPanel: (ticker: string) => void;
  moveFactorDetailPanel: (ticker: string, x: number, y: number) => void;
  resizeFactorDetailPanel: (ticker: string, w: number, h: number) => void;
  focusFactorDetailPanel: (ticker: string) => void;
  setFactorGridSectorFilter: (s: string | null) => void;
  setFactorGridSubThemeFilter: (s: string | null) => void;
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
      factorWindow: 378,
      factorEwHalfLife: null,
      factorPeriod: "1Y",
      factorView: "portfolio",
      factorGridMetric: "beta",
      factorTsRollingWindow: 60,
      factorAttributionMode: "log",
      openFactorDetailPanels: [],
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
      version: 4,
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
        if (version < 3 && next.factorWindow === 252) {
          next.factorWindow = 378;
        }
        if (version < 4) {
          delete next.factorGridSelectedTicker;
        }
        return next;
      },
    },
  ),
);
