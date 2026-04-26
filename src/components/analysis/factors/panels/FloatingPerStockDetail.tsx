"use client";
/**
 * FloatingPerStockDetail — portal-rendered, draggable, resizable wrapper around
 * PerStockDetail. Multiple instances coexist (capped via the analysis store);
 * each is positioned and stacked from `useAnalysisStore.openFactorDetailPanels`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type FactorDetailPanel,
  useAnalysisStore,
} from "@/store/analysis";
import type { PerStockResult } from "@/server/services/factor-per-stock.service";
import { PerStockDetail } from "./PerStockDetail";

interface FloatingPerStockDetailProps {
  panel: FactorDetailPanel;
  data: PerStockResult;
}

const MIN_W = 360;
const MIN_H = 400;
const MAX_W = 1100;
const MAX_H = 1100;

const TITLE_BAR_HEIGHT = 28;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function FloatingPerStockDetail({ panel, data }: FloatingPerStockDetailProps) {
  const moveFactorDetailPanel = useAnalysisStore((s) => s.moveFactorDetailPanel);
  const resizeFactorDetailPanel = useAnalysisStore((s) => s.resizeFactorDetailPanel);
  const closeFactorDetailPanel = useAnalysisStore((s) => s.closeFactorDetailPanel);
  const focusFactorDetailPanel = useAnalysisStore((s) => s.focusFactorDetailPanel);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    panelX: number;
    panelY: number;
  } | null>(null);

  const resizeRef = useRef<{
    startX: number;
    startY: number;
    panelW: number;
    panelH: number;
  } | null>(null);

  const onTitleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Ignore clicks on the close button (its own onClick stops propagation,
      // but be defensive with target tag check).
      if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
      e.preventDefault();
      focusFactorDetailPanel(panel.ticker);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        panelX: panel.x,
        panelY: panel.y,
      };
      const onMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = ev.clientX - drag.startX;
        const dy = ev.clientY - drag.startY;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // Clamp so a usable strip of the title bar always stays in the viewport.
        const nextX = clamp(drag.panelX + dx, 8 - panel.w + 80, vw - 80);
        const nextY = clamp(drag.panelY + dy, 0, vh - TITLE_BAR_HEIGHT);
        moveFactorDetailPanel(panel.ticker, nextX, nextY);
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [panel.ticker, panel.x, panel.y, panel.w, focusFactorDetailPanel, moveFactorDetailPanel],
  );

  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      focusFactorDetailPanel(panel.ticker);
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        panelW: panel.w,
        panelH: panel.h,
      };
      const onMove = (ev: MouseEvent) => {
        const r = resizeRef.current;
        if (!r) return;
        const dx = ev.clientX - r.startX;
        const dy = ev.clientY - r.startY;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const nextW = clamp(r.panelW + dx, MIN_W, Math.min(MAX_W, vw - panel.x - 8));
        const nextH = clamp(r.panelH + dy, MIN_H, Math.min(MAX_H, vh - panel.y - 8));
        resizeFactorDetailPanel(panel.ticker, nextW, nextH);
      };
      const onUp = () => {
        resizeRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [panel.ticker, panel.w, panel.h, panel.x, panel.y, focusFactorDetailPanel, resizeFactorDetailPanel],
  );

  // Re-clamp position into the viewport on window resize so panels never get lost.
  useEffect(() => {
    function onResize() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const nextX = clamp(panel.x, 8 - panel.w + 80, vw - 80);
      const nextY = clamp(panel.y, 0, vh - TITLE_BAR_HEIGHT);
      if (nextX !== panel.x || nextY !== panel.y) {
        moveFactorDetailPanel(panel.ticker, nextX, nextY);
      }
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [panel.ticker, panel.x, panel.y, panel.w, moveFactorDetailPanel]);

  if (!mounted) return null;

  const node = (
    <div
      role="dialog"
      aria-label={`Factor detail for ${panel.ticker}`}
      onMouseDown={() => focusFactorDetailPanel(panel.ticker)}
      style={{
        position: "fixed",
        left: panel.x,
        top: panel.y,
        width: panel.w,
        height: panel.h,
        zIndex: 100 + panel.z,
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
        <div style={{ flex: 1, fontWeight: 700, letterSpacing: "0.05em" }}>{panel.ticker}</div>
        <button
          data-no-drag
          onClick={(e) => {
            e.stopPropagation();
            closeFactorDetailPanel(panel.ticker);
          }}
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

      <div style={{ flex: 1, minHeight: 0 }}>
        <PerStockDetail data={data} selectedTicker={panel.ticker} />
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
