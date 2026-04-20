"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DateRange = "1M" | "3M" | "6M" | "1Y" | "3Y" | "ALL";
export type FactorModelPreset = "CAPM" | "FF3" | "CARHART4" | "FF5" | "EXTENDED";
export type FactorWindow = 20 | 60 | 120 | 252;
export type FactorPeriod = "1D" | "5D" | "MTD" | "QTD" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "ITD";

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
  setActivePortfolio: (id: string | null) => void;
  setDateRange: (r: DateRange) => void;
  markOnboardingDone: () => void;
  addToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
  setFactorModel: (m: FactorModelPreset) => void;
  setFactorWindow: (w: FactorWindow) => void;
  setFactorEwHalfLife: (hl: number | null) => void;
  setFactorPeriod: (p: FactorPeriod) => void;
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
      factorModel: "FF5",
      factorWindow: 252,
      factorEwHalfLife: null,
      factorPeriod: "1Y",
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
    }),
    {
      name: "analysis-store",
      partialize: (s) => ({
        activePortfolioId: s.activePortfolioId,
        dateRange: s.dateRange,
        onboardingDone: s.onboardingDone,
        factorModel: s.factorModel,
        factorWindow: s.factorWindow,
        factorEwHalfLife: s.factorEwHalfLife,
        factorPeriod: s.factorPeriod,
      }),
    },
  ),
);
