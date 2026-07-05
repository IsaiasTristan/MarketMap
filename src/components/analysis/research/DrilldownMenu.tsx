"use client";
/**
 * "MORE ▾" overflow button for the demoted drill-down views (Trajectory /
 * Rotation Flow / Breadth Heatmap). Composed NEXT TO the shared
 * BloombergTabStrip rather than extending it (the strip is shared with
 * Flows/Factors). When a drill-down is active the button shows its label with
 * the active-tab styling.
 */
import { useEffect, useRef, useState } from "react";

export interface DrilldownItem {
  key: string;
  label: string;
}

export function DrilldownMenu({
  items,
  activeKey,
  onSelect,
}: {
  items: DrilldownItem[];
  activeKey: string | null;
  onSelect: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = items.find((i) => i.key === activeKey) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex" }}>
      <button
        type="button"
        className={active ? "bb-tab bb-tab--active" : "bb-tab"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {active ? `${active.label} ▾` : "MORE ▾"}
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            zIndex: 150,
            minWidth: 190,
            background: "var(--bg-elevated, #141414)",
            border: "1px solid var(--bg-border, #2a2a2a)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
          }}
        >
          {items.map((i) => (
            <button
              key={i.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSelect(i.key);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                padding: "7px 12px",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                color: i.key === activeKey ? "var(--color-accent)" : "var(--text-secondary)",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-surface)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
