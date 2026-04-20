"use client";
import { useState, useRef } from "react";

export interface InfoTooltipProps {
  name: string;
  definition: string;
  formula?: string;
  goodValue?: string;
  currentValue?: string;
  passing?: boolean;
}

const TOOLTIP_WIDTH = 260;
// Conservative height estimate so we don't need to measure the DOM.
const TOOLTIP_HEIGHT_ESTIMATE = 220;

export function InfoTooltip({
  name,
  definition,
  formula,
  goodValue,
  currentValue,
  passing,
}: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{
    vertical: "above" | "below";
    horizontal: "center" | "left" | "right";
  }>({ vertical: "below", horizontal: "center" });
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleOpen = () => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const vw = window.innerWidth;

      // Vertical: prefer above, but flip below if not enough room above
      const vertical: "above" | "below" =
        rect.top < TOOLTIP_HEIGHT_ESTIMATE + 16 ? "below" : "above";

      // Horizontal: center by default, flip left if overflows right edge,
      // flip right if overflows left edge
      let horizontal: "center" | "left" | "right" = "center";
      const halfW = TOOLTIP_WIDTH / 2;
      if (rect.left + halfW > vw - 16) horizontal = "left";
      else if (rect.right - halfW < 16) horizontal = "right";

      setPlacement({ vertical, horizontal });
    }
    setOpen(true);
  };

  // Build the position style from the computed placement
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

  const tooltipStyle: React.CSSProperties = {
    position: "absolute",
    ...vertStyle,
    ...horizStyle,
  };

  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={btnRef}
        onMouseEnter={handleOpen}
        onMouseLeave={() => setOpen(false)}
        onFocus={handleOpen}
        onBlur={() => setOpen(false)}
        aria-label={`Info about ${name}`}
        style={{
          background: "none",
          border: "none",
          cursor: "help",
          color: "var(--text-muted)",
          fontSize: 13,
          padding: "0 2px",
          lineHeight: 1,
        }}
      >
        ⓘ
      </button>
      {open && (
        <div
          style={{
            ...tooltipStyle,
            width: TOOLTIP_WIDTH,
            background: "var(--bg-elevated)",
            border: "1px solid var(--bg-border)",
            borderRadius: 8,
            padding: 14,
            zIndex: 100,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: 8,
            }}
          >
            {name}
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-secondary)",
              lineHeight: 1.5,
              marginBottom: formula ? 8 : 0,
            }}
          >
            {definition}
          </div>
          {formula && (
            <>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginTop: 6,
                  marginBottom: 2,
                }}
              >
                Formula:
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-jetbrains-mono, monospace)",
                  color: "var(--color-info)",
                  background: "var(--bg-base)",
                  padding: "4px 8px",
                  borderRadius: 4,
                  marginBottom: goodValue ? 8 : 0,
                }}
              >
                {formula}
              </div>
            </>
          )}
          {goodValue && (
            <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              <span style={{ color: "var(--text-muted)" }}>Good value: </span>
              {goodValue}
            </div>
          )}
          {currentValue && (
            <div style={{ fontSize: 11, marginTop: 2 }}>
              <span style={{ color: "var(--text-muted)" }}>Your value: </span>
              <span
                style={{
                  color:
                    passing === true
                      ? "var(--color-positive)"
                      : passing === false
                        ? "var(--color-negative)"
                        : "var(--text-primary)",
                  fontFamily: "var(--font-jetbrains-mono, monospace)",
                }}
              >
                {currentValue}
                {passing === true ? " ✓" : passing === false ? " ✗" : ""}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
