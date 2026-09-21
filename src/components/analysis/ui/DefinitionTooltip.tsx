"use client";
/**
 * Generic metric-definition tooltip. Renders a term with a dotted-underline
 * affordance; the definition opens on HOVER, keyboard FOCUS, and tap-to-toggle.
 *
 * The popover is rendered through a PORTAL to document.body with FIXED
 * coordinates measured off the trigger, so it can never be clipped by a
 * panel's `overflow: hidden` / `overflow: auto` (the whole-app tooltip bug).
 * Flips above/below and left/right to stay in the viewport; on small viewports
 * it drops to a bottom sheet. aria-describedby wires the popover to the trigger.
 *
 * Registry-agnostic: takes a resolved MetricDef. Engine-scoped wrappers
 * (flows/MetricTooltip, research/MetricTip, pairs/PairMetricTip) bind their own
 * registries so text comes from a registry, never inline strings.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MetricDef } from "@/lib/analysis/metric-def";

const PANEL_WIDTH = 300;
const GAP = 7;
const MARGIN = 8;

export function DefinitionTooltip({
  def,
  children,
  className,
  style,
}: {
  def: MetricDef;
  /** Override the displayed term; defaults to the registry label. */
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    sheet: boolean;
  }>({ top: 0, left: 0, width: PANEL_WIDTH, sheet: false });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const tipId = useId();

  useEffect(() => setMounted(true), []);

  const measure = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (vw <= 640) {
      setPos({ top: 0, left: 0, width: vw - 2 * MARGIN, sheet: true });
      return;
    }
    const width = Math.min(PANEL_WIDTH, vw - 2 * MARGIN);
    // Prefer left-aligned; flip to the right edge if it would overflow.
    let left = r.left;
    if (left + width > vw - MARGIN) left = Math.max(MARGIN, r.right - width);
    const panelH = panelRef.current?.offsetHeight ?? 0;
    // Prefer above; drop below if there isn't room and below has more.
    const above = r.top - GAP - panelH;
    const below = r.bottom + GAP;
    const top = above >= MARGIN || r.top > vh - r.bottom ? Math.max(MARGIN, above) : below;
    setPos({ top, left, width, sheet: false });
  };

  // Measure after the panel mounts (so we know its height) and on open.
  useLayoutEffect(() => {
    if (open) measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => measure();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const show = () => setOpen(true);
  const hide = () => setOpen(false);

  const panelStyle: React.CSSProperties = pos.sheet
    ? {
        position: "fixed",
        left: MARGIN,
        right: MARGIN,
        bottom: MARGIN,
        width: "auto",
        zIndex: 2000,
      }
    : {
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: pos.width,
        zIndex: 2000,
      };

  return (
    <span style={{ position: "relative", display: "inline" }}>
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-describedby={open ? tipId : undefined}
        aria-expanded={open}
        className={className}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          e.stopPropagation();
          open ? hide() : show();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open ? hide() : show();
          }
        }}
        style={{
          borderBottom: "1px dotted var(--text-muted)",
          cursor: "help",
          ...style,
        }}
      >
        {children ?? def.label}
      </span>
      {open && mounted &&
        createPortal(
          <span
            ref={panelRef}
            id={tipId}
            role="tooltip"
            style={{
              ...panelStyle,
              display: "block",
              boxSizing: "border-box",
              background: "#0e0e0e",
              border: "1px solid var(--color-accent)",
              padding: "7px 9px",
              color: "var(--text-primary, #d8d8d8)",
              fontSize: 10.5,
              lineHeight: 1.35,
              fontWeight: 400,
              letterSpacing: 0,
              textTransform: "none",
              textAlign: "left",
              whiteSpace: "normal",
              boxShadow: "0 6px 18px rgba(0,0,0,0.85)",
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                display: "block",
                fontWeight: 700,
                marginBottom: 3,
                letterSpacing: 0.5,
                color: "var(--color-accent)",
              }}
            >
              {def.label}
            </span>
            <span style={{ display: "block", color: "var(--text-primary)" }}>{def.short_def}</span>
            {def.calculation && (
              <span style={{ display: "block", marginTop: 5, color: "var(--text-secondary)" }}>{def.calculation}</span>
            )}
            {def.caveats && <span style={{ display: "block", marginTop: 5, color: "var(--text-muted)" }}>{def.caveats}</span>}
            {def.basis && <span style={{ display: "block", marginTop: 5, color: "var(--text-muted)" }}>{def.basis}</span>}
            {def.arithmetic && (
              <span style={{ display: "block", marginTop: 5, color: "var(--color-accent)", fontVariantNumeric: "tabular-nums" }}>
                {def.arithmetic}
              </span>
            )}
          </span>,
          document.body,
        )}
    </span>
  );
}
