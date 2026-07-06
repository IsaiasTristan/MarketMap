"use client";
import { useState } from "react";

interface WarningsChipProps {
  warnings: string[] | null | undefined;
  /** Optional chip label override. Defaults to "N warning(s)". */
  label?: string;
}

/**
 * Compact yellow ⚠ chip that consolidates a list of warning strings into a
 * single indicator, revealing the full (scrollable) list in a hover/focus
 * popup. Replaces the old raw <ul> dumps that could fill the screen when a
 * condition hit the whole universe (e.g. a post-holiday "live overlay skipped"
 * warning for every ticker). Modeled on the CoverageWarning chip pattern.
 */
export function WarningsChip({ warnings, label }: WarningsChipProps) {
  const [open, setOpen] = useState(false);

  const items = warnings ?? [];
  if (items.length === 0) return null;

  const n = items.length;
  const chipLabel = label ?? `${n} warning${n === 1 ? "" : "s"}`;

  return (
    <div
      style={{
        position: "relative",
        display: "inline-flex",
        alignSelf: "flex-start",
        marginBottom: "0.5rem",
      }}
    >
      <span
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        tabIndex={0}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 9px",
          background: "rgba(245,158,11,0.08)",
          border: "1px solid rgba(245,158,11,0.35)",
          borderRadius: 2,
          fontSize: 11,
          fontWeight: 600,
          color: "var(--color-warning, #f59e0b)",
          cursor: "help",
          letterSpacing: "0.02em",
          whiteSpace: "nowrap",
        }}
      >
        <span aria-hidden style={{ fontSize: 12, lineHeight: 1 }}>
          ⚠
        </span>
        {chipLabel}
      </span>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            width: 380,
            maxWidth: "90vw",
            background: "var(--bg-elevated)",
            border: "1px solid var(--bg-border)",
            borderRadius: 2,
            padding: 14,
            zIndex: 200,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: "var(--text-primary)",
              marginBottom: 8,
            }}
          >
            {n} warning{n === 1 ? "" : "s"}
          </div>
          <div
            style={{
              maxHeight: 280,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {items.map((w, i) => (
              <div
                key={i}
                style={{
                  fontSize: 11,
                  lineHeight: 1.4,
                  color: "var(--text-secondary)",
                  fontFamily: "var(--font-mono, monospace)",
                }}
              >
                {w}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
