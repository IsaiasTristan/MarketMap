"use client";
/**
 * FloatingPortfolioDetail — portal-rendered, draggable, resizable wrapper that
 * shows the portfolio-level factor view in a floating window.
 *
 * Triggered by clicking the "Total Portfolio" row in `PortfolioFactorGrid`.
 * The portfolio's β / α / risk / R² come from the same OLS that powers the
 * inline PortfolioTotalsPanel / TimeSeriesPanel — we just reuse those
 * components inside the floating window so the user sees the same numbers
 * with no fresh refit (the data is already on the page).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PortfolioTotalsPanel } from "./PortfolioTotalsPanel";
import { TimeSeriesPanel } from "./TimeSeriesPanel";
import type {
  FactorExposureSnapshot,
  AttributionResult,
  RiskDecomposition,
} from "@/types/factors";
import type { FactorPeriod } from "@/store/analysis";

interface FloatingPortfolioDetailProps {
  exposure: FactorExposureSnapshot | null;
  attribution: AttributionResult | null | undefined;
  risk: RiskDecomposition | null | undefined;
  history: Parameters<typeof TimeSeriesPanel>[0]["history"];
  selectedPeriod: FactorPeriod;
  onClose: () => void;
}

const MIN_W = 480;
const MIN_H = 420;
const MAX_W = 1400;
const MAX_H = 1200;
const TITLE_BAR_HEIGHT = 28;
const DEFAULT_W = 880;
const DEFAULT_H = 720;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function FloatingPortfolioDetail({
  exposure,
  attribution,
  risk,
  history,
  selectedPeriod,
  onClose,
}: FloatingPortfolioDetailProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Initial position roughly centered, with a slight offset so it doesn't
  // sit exactly on top of any per-stock panel that may already be open.
  const [pos, setPos] = useState(() => {
    if (typeof window === "undefined") return { x: 120, y: 80, w: DEFAULT_W, h: DEFAULT_H };
    const w = Math.min(DEFAULT_W, window.innerWidth - 80);
    const h = Math.min(DEFAULT_H, window.innerHeight - 80);
    return {
      x: Math.max(40, (window.innerWidth - w) / 2),
      y: Math.max(40, (window.innerHeight - h) / 2 - 40),
      w,
      h,
    };
  });

  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; panelW: number; panelH: number } | null>(null);

  const onTitleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startY: e.clientY, panelX: pos.x, panelY: pos.y };
      const onMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        setPos((p) => ({
          ...p,
          x: clamp(drag.panelX + (ev.clientX - drag.startX), 8 - p.w + 80, vw - 80),
          y: clamp(drag.panelY + (ev.clientY - drag.startY), 0, vh - TITLE_BAR_HEIGHT),
        }));
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [pos.x, pos.y],
  );

  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = { startX: e.clientX, startY: e.clientY, panelW: pos.w, panelH: pos.h };
      const onMove = (ev: MouseEvent) => {
        const r = resizeRef.current;
        if (!r) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        setPos((p) => ({
          ...p,
          w: clamp(r.panelW + (ev.clientX - r.startX), MIN_W, Math.min(MAX_W, vw - p.x - 8)),
          h: clamp(r.panelH + (ev.clientY - r.startY), MIN_H, Math.min(MAX_H, vh - p.y - 8)),
        }));
      };
      const onUp = () => {
        resizeRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [pos.w, pos.h],
  );

  if (!mounted) return null;

  const node = (
    <div
      role="dialog"
      aria-label="Portfolio factor detail"
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: pos.w,
        height: pos.h,
        zIndex: 200,
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.55)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        onMouseDown={onTitleMouseDown}
        style={{
          background: "var(--bb-chrome)",
          color: "#fff",
          padding: "6px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          cursor: "move",
          userSelect: "none",
          height: TITLE_BAR_HEIGHT,
          flexShrink: 0,
        }}
      >
        <div style={{ flex: 1, fontWeight: 700, letterSpacing: "0.05em" }}>
          PORTFOLIO · Factor Detail
        </div>
        <button
          data-no-drag
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          style={{
            background: "transparent",
            border: "none",
            color: "#fff",
            fontSize: 14,
            cursor: "pointer",
            padding: 0,
            lineHeight: 1,
          }}
          title="Close"
        >
          ✕
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Total Return + Total Risk waterfalls (signed-weighted at the
            data layer — risk decomp uses true portfolio OLS). */}
        <PortfolioTotalsPanel
          exposure={exposure}
          attribution={attribution}
          risk={risk}
          selectedPeriod={selectedPeriod}
        />

        {/* Rolling factor β over time, plus per-period attribution. */}
        <TimeSeriesPanel history={history} attribution={attribution} />
      </div>

      <div
        onMouseDown={onResizeMouseDown}
        title="Drag to resize"
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 14,
          height: 14,
          cursor: "nwse-resize",
          background:
            "linear-gradient(135deg, transparent 0 50%, rgba(255,255,255,0.35) 50% 60%, transparent 60% 70%, rgba(255,255,255,0.35) 70% 80%, transparent 80%)",
        }}
      />
    </div>
  );

  return createPortal(node, document.body);
}
