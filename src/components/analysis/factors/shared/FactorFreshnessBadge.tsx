"use client";
/**
 * FactorFreshnessBadge — a single small chip used on every surface that shows
 * a 1D factor decomposition. Makes the live-vs-at-close distinction legible
 * at a glance so users always know what data their numbers came from:
 *
 *   • mode="live"         → green pulsing dot + "LIVE 1D · h:mm:ss ET"
 *   • mode="today-close"  → neutral steady dot + "1D close · h:mm a ET, MMM d"
 *   • mode="at-close"     → neutral dot + "1D at close · <date>"
 *   • mode="loading"      → muted dot + "Loading live 1D…"
 *
 * Used by:
 *   • PerStockDetail / FloatingPerStockDetail (market-map popup + Factors-tab
 *     per-stock detail panel) — live 1D when the popup is on the 1D period.
 *   • PortfolioTotalsPanel — live 1D when REGULAR; today-close after the bell.
 *   • PerStockGrid / PortfolioFactorGrid — always at-close for the 1D column
 *     (full-grid live would mean hundreds of quotes per refresh — bounded by
 *     drill-in instead; the badge spells out exactly why).
 *
 * The tooltip text is single-sourced here so the "drill into a stock for live"
 * message is identical wherever it appears.
 */
import type { CSSProperties, ReactNode } from "react";

export type FactorFreshnessMode = "live" | "today-close" | "at-close" | "loading";

interface FactorFreshnessBadgeProps {
  mode: FactorFreshnessMode;
  /**
   * For mode="live": ISO timestamp when the live row was composed (renders
   *   as h:mm:ss ET).
   * For mode="today-close": ISO timestamp when the row was composed (renders
   *   as h:mm a ET, MMM d).
   * For mode="at-close": ISO date the cached row was computed for.
   * Ignored for "loading".
   */
  asOf?: string | null;
  /**
   * Surface label used in the tooltip — e.g. "grid", "portfolio", "stock".
   * Lets the same chip surface a context-aware "drill into a stock for live"
   * line on the grid without overloading users on per-stock surfaces.
   */
  surface?: "grid" | "stock" | "portfolio";
  /** Optional extra trailing text in the chip body (e.g. "· 12 of 14 factors"). */
  trailing?: ReactNode;
  /**
   * When live 1D is unavailable but the static bucket is stale (endDate != today
   * ET), append this reason to the at-close tooltip.
   */
  staleLiveReason?: string | null;
}

function formatTimeEt(iso: string): string {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).format(d);
  } catch {
    return iso;
  }
}

function formatCloseEt(iso: string): string {
  try {
    const d = new Date(iso);
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d);
    const date = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
    }).format(d);
    return `${time} ET, ${date}`;
  } catch {
    return iso;
  }
}

function formatDate(iso: string): string {
  try {
    // Accept either YYYY-MM-DD or a full ISO timestamp.
    const dateOnly = iso.length >= 10 ? iso.slice(0, 10) : iso;
    const d = new Date(`${dateOnly}T12:00:00Z`);
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(d);
  } catch {
    return iso;
  }
}

const baseChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 7px",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  fontFamily: "var(--font-mono, monospace)",
  fontVariantNumeric: "tabular-nums",
  border: "1px solid",
  borderRadius: 2,
  whiteSpace: "nowrap",
  cursor: "help",
};

const dotBase: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  display: "inline-block",
  flexShrink: 0,
};

export function FactorFreshnessBadge({
  mode,
  asOf,
  surface = "stock",
  trailing,
  staleLiveReason,
}: FactorFreshnessBadgeProps) {
  // Inline keyframes so the pulse works without depending on a global
  // stylesheet declaration. Defined once per render — cheap and self-contained.
  const pulseKeyframes = `@keyframes mm-live-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.8); }
  }`;

  let chipStyle: CSSProperties;
  let dotStyle: CSSProperties;
  let label: string;
  let tooltip: string;

  if (mode === "live") {
    chipStyle = {
      ...baseChip,
      background: "rgba(34,197,94,0.10)",
      borderColor: "rgba(34,197,94,0.45)",
      color: "#22c55e",
    };
    dotStyle = {
      ...dotBase,
      background: "#22c55e",
      boxShadow: "0 0 4px rgba(34,197,94,0.7)",
      animation: "mm-live-pulse 1.8s ease-in-out infinite",
    };
    const t = asOf ? formatTimeEt(asOf) : "now";
    label = `LIVE 1D · ${t} ET`;
    tooltip =
      `1D decomposition computed from LIVE intraday Yahoo quotes for the underlying ` +
      `factor ETFs (ACWI, SPY, IEF, DBC, EEM, UUP, TIP, USMV, QUAL, DBMF, GVIP, SVXY, ` +
      `MTUM, IVE/IVW). Saved horizon-OLS betas + alpha are reused; only TODAY's ` +
      `single-day returns are live.\n\n` +
      `Refreshes ~30s. Drops back to the at-close cached slice the moment the live ` +
      `feed is unavailable (Yahoo throttled or partial coverage).`;
  } else if (mode === "today-close") {
    chipStyle = {
      ...baseChip,
      background: "rgba(255,255,255,0.04)",
      borderColor: "rgba(255,255,255,0.20)",
      color: "var(--text-secondary)",
    };
    dotStyle = { ...dotBase, background: "var(--text-secondary)" };
    const t = asOf ? formatCloseEt(asOf) : "today";
    label = `1D close · ${t}`;
    tooltip =
      `1D decomposition computed from today's official 16:00 ET closing print ` +
      `for every factor ETF (live feed paused — REGULAR hours are over). Saved ` +
      `horizon-OLS betas + alpha are reused; only TODAY's single-day returns are ` +
      `live.\n\n` +
      `Refreshes every 5 minutes (data is static after the close).`;
  } else if (mode === "loading") {
    chipStyle = {
      ...baseChip,
      background: "rgba(255,255,255,0.04)",
      borderColor: "rgba(255,255,255,0.20)",
      color: "var(--text-muted)",
    };
    dotStyle = {
      ...dotBase,
      background: "var(--text-muted)",
      animation: "mm-live-pulse 1.8s ease-in-out infinite",
    };
    label = "Loading live 1D…";
    tooltip = "Fetching live factor ETF quotes.";
  } else {
    chipStyle = {
      ...baseChip,
      background: "rgba(255,255,255,0.04)",
      borderColor: "rgba(255,255,255,0.20)",
      color: "var(--text-secondary)",
    };
    dotStyle = { ...dotBase, background: "var(--text-muted)" };
    const dateLabel = asOf ? formatDate(asOf) : "last close";
    label = `1D at close · ${dateLabel}`;
    if (surface === "grid") {
      tooltip =
        `Full-grid 1D is computed at the last completed close (${dateLabel}). ` +
        `Open any stock from the grid (or from the market map) for its live ` +
        `intraday decomposition during US regular hours.\n\n` +
        `Live full-grid would mean hundreds of intraday quotes per refresh ` +
        `— consistency was traded for performance here. Drill-in for live.`;
    } else if (surface === "portfolio") {
      tooltip =
        `Portfolio 1D from the last completed close (${dateLabel}). Live ` +
        `intraday updates require a live feed for the factor ETFs + every holding — ` +
        `falling back to at-close because live data is unavailable.`;
      if (staleLiveReason) {
        tooltip +=
          `\n\nLive unavailable (${staleLiveReason}). Showing last ingested close (${dateLabel}). ` +
          `Refresh or check that holdings have live Yahoo quotes.`;
      }
    } else {
      tooltip =
        `1D from the last completed close (${dateLabel}). Live intraday ` +
        `requires US regular hours and a live feed for the factor ETFs + ` +
        `this stock — falling back to at-close.`;
    }
  }

  return (
    <span style={chipStyle} title={tooltip} role="status" aria-label={label}>
      <style>{pulseKeyframes}</style>
      <span style={dotStyle} aria-hidden="true" />
      <span>{label}</span>
      {trailing != null && (
        <span style={{ color: "var(--text-muted)", textTransform: "none", fontWeight: 500 }}>
          {trailing}
        </span>
      )}
    </span>
  );
}
