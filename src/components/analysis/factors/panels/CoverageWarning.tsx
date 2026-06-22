"use client";
import { useState } from "react";
import type { PortfolioCoverageDiagnostics } from "@/types/factors";

interface CoverageWarningProps {
  coverage: PortfolioCoverageDiagnostics | null | undefined;
  /** True when the regression could not run at all (engine returned null). */
  failed?: boolean;
}

/**
 * Compact, discrete warning chip surfaced above the Factors tab strip when the
 * portfolio factor regression had to exclude holdings or dates (recent IPOs /
 * short history) or could not run at all. Hovering reveals exactly which
 * stocks and how many dates were removed.
 */
export function CoverageWarning({ coverage, failed }: CoverageWarningProps) {
  const [open, setOpen] = useState(false);

  const shortHistory = coverage?.shortHistoryPositions ?? [];
  const excluded = coverage?.excludedPositions ?? [];
  const droppedDates = coverage?.droppedLowCoverageDates ?? 0;
  const hasDrops = shortHistory.length > 0 || excluded.length > 0 || droppedDates > 0;

  // Nothing to warn about when the regression ran cleanly with full coverage.
  if (!failed && !hasDrops) return null;

  const removedCount = shortHistory.length + excluded.length;
  const label = failed
    ? "Factor regression unavailable"
    : `${removedCount} holding${removedCount === 1 ? "" : "s"}${
        droppedDates > 0 ? ` · ${droppedDates} date${droppedDates === 1 ? "" : "s"}` : ""
      } excluded`;

  const accent = failed ? "var(--color-warning, #f59e0b)" : "#f59e0b";

  return (
    <div style={{ position: "relative", display: "inline-flex", alignSelf: "flex-start" }}>
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
          color: accent,
          cursor: "help",
          letterSpacing: "0.02em",
          whiteSpace: "nowrap",
        }}
      >
        <span aria-hidden style={{ fontSize: 12, lineHeight: 1 }}>⚠</span>
        {label}
      </span>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            width: 320,
            background: "var(--bg-elevated)",
            border: "1px solid var(--bg-border)",
            borderRadius: 2,
            padding: 14,
            zIndex: 200,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
            {failed ? "Not enough data to regress" : "Some holdings excluded from regression"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 8 }}>
            {failed
              ? "There aren't enough aligned trading days between your holdings and the factor series. The holdings below have the least price history — add more history or older positions, then refresh the pipeline."
              : "These holdings have insufficient price history for the full window, so they are excluded from the regression only over the dates where their data is missing (e.g. before a recent IPO). The rest of the portfolio is regressed normally."}
          </div>

          {shortHistory.length > 0 && (
            <div style={{ marginBottom: excluded.length > 0 || droppedDates > 0 ? 8 : 0 }}>
              <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                Short history
              </div>
              {shortHistory.slice(0, 12).map((p) => (
                <div
                  key={p.ticker}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-mono, monospace)",
                    padding: "1px 0",
                  }}
                >
                  <span style={{ color: "var(--text-primary)" }}>{p.ticker}</span>
                  <span>
                    from {p.firstDate || "?"} · {p.observations}d
                  </span>
                </div>
              ))}
              {shortHistory.length > 12 && (
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
                  +{shortHistory.length - 12} more
                </div>
              )}
            </div>
          )}

          {excluded.length > 0 && (
            <div style={{ marginBottom: droppedDates > 0 ? 8 : 0 }}>
              <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                Excluded entirely
              </div>
              {excluded.slice(0, 12).map((p) => (
                <div
                  key={p.ticker}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-mono, monospace)",
                    padding: "1px 0",
                  }}
                >
                  <span style={{ color: "var(--text-primary)" }}>{p.ticker}</span>
                  <span>{p.reason}</span>
                </div>
              ))}
            </div>
          )}

          {droppedDates > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              <span style={{ color: "var(--text-muted)" }}>Dates dropped (low coverage): </span>
              <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{droppedDates}</span>
            </div>
          )}

          {coverage?.seriesStart && coverage?.seriesEnd && (
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 8 }}>
              Regression sample: {coverage.seriesStart} → {coverage.seriesEnd} ({coverage.alignedDates}d)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
