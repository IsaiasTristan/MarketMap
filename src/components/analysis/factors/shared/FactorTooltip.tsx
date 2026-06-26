"use client";
/**
 * FactorTooltip — wraps a factor label so hovering it surfaces a concise
 * popup explaining what the factor is and how it's calculated. Sourced from
 * the canonical `getFactorDef` metadata (or explicit overrides for non-factor
 * rows like the Alpha residual). Mirrors the placement logic of the shared
 * `InfoTooltip` so the popup never clips off-screen.
 */
import { useState, useRef } from "react";
import type { ReactNode } from "react";
import type { FactorCode } from "@/types/factors";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";

interface FactorTooltipProps {
  /** When set, name / definition / how-calculated are pulled from getFactorDef. */
  code?: FactorCode;
  /** Explicit overrides (used for the Alpha residual or non-factor rows). */
  name?: string;
  definition?: string;
  howCalculated?: string;
  /**
   * Underlying data/series used to build the metric (ETF ticker, AQR/Ken
   * French series, provider). When `code` is set this defaults to the factor
   * def's `dataSource`. Rendered as a "Data used" section.
   */
  dataUsed?: string;
  /**
   * Concise mode: trim the definition body to its first sentence so dense
   * grid/heatmap headers get a one-line "what it is" + the full
   * "how it's calculated" line. Defaults to false (full definition).
   */
  concise?: boolean;
  /** The visible label that acts as the hover trigger. */
  children: ReactNode;
}

/** First sentence of a definition, for the concise tooltip variant. */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^(.*?[.!?])(\s|$)/);
  return match ? match[1]! : trimmed;
}

const TOOLTIP_WIDTH = 260;
const TOOLTIP_HEIGHT_ESTIMATE = 180;

export function FactorTooltip({
  code,
  name,
  definition,
  howCalculated,
  dataUsed,
  concise = false,
  children,
}: FactorTooltipProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{
    vertical: "above" | "below";
    horizontal: "center" | "left" | "right";
  }>({ vertical: "above", horizontal: "center" });
  const triggerRef = useRef<HTMLSpanElement>(null);

  const def = code ? getFactorDef(code) : null;
  const title = name ?? def?.label ?? "";
  const rawBody = definition ?? def?.description ?? "";
  const body = concise && rawBody ? firstSentence(rawBody) : rawBody;
  const formula = howCalculated ?? def?.howCalculated ?? "";
  const data = dataUsed ?? def?.dataSource ?? "";

  const handleOpen = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const vw = window.innerWidth;
      const vertical: "above" | "below" =
        rect.top < TOOLTIP_HEIGHT_ESTIMATE + 16 ? "below" : "above";
      let horizontal: "center" | "left" | "right" = "center";
      const halfW = TOOLTIP_WIDTH / 2;
      if (rect.left + halfW > vw - 16) horizontal = "left";
      else if (rect.right - halfW < 16) horizontal = "right";
      setPlacement({ vertical, horizontal });
    }
    setOpen(true);
  };

  const vertStyle: React.CSSProperties =
    placement.vertical === "above"
      ? { bottom: "calc(100% + 8px)", top: "auto" }
      : { top: "calc(100% + 8px)", bottom: "auto" };

  const horizStyle: React.CSSProperties =
    placement.horizontal === "left"
      ? { right: 0, left: "auto", transform: "none" }
      : placement.horizontal === "right"
        ? { left: 0, right: "auto", transform: "none" }
        : { left: "50%", transform: "translateX(-50%)" };

  return (
    <span style={{ position: "relative", display: "inline-flex", minWidth: 0 }}>
      <span
        ref={triggerRef}
        onMouseEnter={handleOpen}
        onMouseLeave={() => setOpen(false)}
        onFocus={handleOpen}
        onBlur={() => setOpen(false)}
        tabIndex={0}
        style={{ cursor: "help", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {children}
      </span>
      {open && (title || body) && (
        <div
          style={{
            position: "absolute",
            ...vertStyle,
            ...horizStyle,
            width: TOOLTIP_WIDTH,
            background: "var(--bg-elevated)",
            border: "1px solid var(--bg-border)",
            borderRadius: 2,
            padding: 12,
            zIndex: 100,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            whiteSpace: "normal",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>
            {title}
          </div>
          {body && (
            <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {body}
            </div>
          )}
          {formula && (
            <>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 8, marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                How it&apos;s calculated
              </div>
              <div style={{ fontSize: 11, color: "var(--color-info)", lineHeight: 1.4 }}>
                {formula}
              </div>
            </>
          )}
          {data && (
            <>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 8, marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Data used
              </div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.4 }}>
                {data}
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}
