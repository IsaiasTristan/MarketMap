"use client";
/**
 * Metric definition tooltip (Fund Overview Part 4c). Renders a term with a dotted-
 * underline affordance; the definition (from the shared metric registry) opens on
 * HOVER, keyboard FOCUS, and tap-to-toggle. Right-edge flip; on small viewports it
 * drops to a bottom-sheet. aria-describedby wires the popover to the trigger.
 *
 * This is the single tooltip surface for every metric label across the flows tabs —
 * text comes from the registry, never inline strings, so definitions can't drift.
 */
import { useEffect, useId, useRef, useState } from "react";
import { metric, type MetricId } from "@/lib/institutional/metric-registry";

const PANEL_WIDTH = 300;

export function MetricTooltip({
  id,
  children,
  className,
  style,
}: {
  id: MetricId;
  /** Override the displayed term; defaults to the registry label. */
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const def = metric(id);
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState<"left" | "right">("left");
  const [sheet, setSheet] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipId = useId();

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    setSheet(vw <= 640);
    // Flip to the right edge if the panel would overflow the viewport on the left-align.
    setFlip(rect.left + PANEL_WIDTH > vw - 12 ? "right" : "left");
  };

  const show = () => {
    place();
    setOpen(true);
  };
  const hide = () => setOpen(false);

  // Close on Escape / outside interaction.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const panelStyle: React.CSSProperties = sheet
    ? {
        position: "fixed",
        left: 12,
        right: 12,
        bottom: 12,
        width: "auto",
        maxWidth: "none",
        zIndex: 200,
      }
    : {
        position: "absolute",
        bottom: "calc(100% + 7px)",
        [flip === "right" ? "right" : "left"]: 0,
        width: PANEL_WIDTH,
        maxWidth: "70vw",
        zIndex: 200,
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
      {open && (
        <span
          id={tipId}
          role="tooltip"
          style={{
            ...panelStyle,
            display: "block",
            background: "var(--bg-elevated, #141414)",
            border: "1px solid var(--bg-border, #2a2a2a)",
            padding: "8px 10px",
            color: "var(--text-primary, #d8d8d8)",
            fontSize: 11,
            lineHeight: 1.55,
            fontWeight: 400,
            letterSpacing: 0,
            textTransform: "none",
            whiteSpace: "normal",
            boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
          }}
        >
          <span style={{ display: "block", fontWeight: 700, marginBottom: 4, color: "var(--text-primary)" }}>{def.label}</span>
          <span style={{ display: "block", color: "var(--text-secondary)" }}>{def.short_def}</span>
          {def.calculation && (
            <span style={{ display: "block", marginTop: 6, color: "var(--text-muted)" }}>{def.calculation}</span>
          )}
          {def.caveats && <span style={{ display: "block", marginTop: 6, color: "var(--text-muted)" }}>{def.caveats}</span>}
        </span>
      )}
    </span>
  );
}
