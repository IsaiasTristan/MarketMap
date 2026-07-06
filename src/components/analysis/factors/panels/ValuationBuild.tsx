"use client";
/**
 * ValuationBuild — FactSet-style enterprise-value build + forward trading
 * multiples for the per-stock detail popup's big headline cell.
 *
 *   FDSO × live price = Market cap
 *   + Total debt − Cash + Preferred equity + Minority interest = TEV
 *   TEV/EBITDA and P/E on NTM and FY+1 consensus underneath.
 *
 * Balance-sheet components and estimate denominators come from the valuation
 * route (FMP, cached server-side once per ET trading date). The price rides
 * the SAME React-Query key as StockPriceChart's 1D series
 * (["price-series", ticker, "1D"]) so the network call is deduped with the
 * chart below — this observer polls every 20s outside CLOSED sessions, so
 * market cap / TEV / multiples tick intraday.
 *
 * Funds/ETFs (kind "fund") degrade to Shares × Price = Market cap with the
 * capital-structure lines and multiples omitted.
 */
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatMultiple, formatStatement } from "@/lib/fundamental/format-statement";
import { getUsMarketSession } from "@/lib/market-map/market-session";
import type { PriceSeriesResult } from "@/server/services/price-series.service";
import type { ValuationSnapshot } from "@/server/services/valuation.service";

const MONO = "var(--font-mono, monospace)";

const fmtPrice = (v: number): string =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Share count → "24,400.0" (millions, 1 dp). */
const fmtSharesM = (v: number): string =>
  (v / 1e6).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Multiple text: "—" when inputs missing, "n/m" when the denominator ≤ 0. */
function multipleText(numerator: number | null, denominator: number | null): string {
  if (numerator === null || denominator === null) return "—";
  if (denominator <= 0) return "n/m";
  return formatMultiple(numerator / denominator);
}

function BuildRow({
  label,
  value,
  bold = false,
  topRule = false,
  muted = false,
}: {
  label: string;
  value: string;
  bold?: boolean;
  topRule?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 8,
        padding: "1px 0",
        ...(topRule ? { borderTop: "1px solid rgba(255,255,255,0.12)", marginTop: 2, paddingTop: 3 } : {}),
      }}
    >
      <span style={{ fontSize: 10, color: muted ? "var(--text-muted)" : "var(--text-secondary, var(--text-muted))" }}>
        {label}
      </span>
      <span
        style={{
          fontSize: 11,
          fontWeight: bold ? 700 : 500,
          fontFamily: MONO,
          fontVariantNumeric: "tabular-nums",
          color: muted ? "var(--text-muted)" : "var(--text-primary)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function ValuationBuild({ ticker }: { ticker: string }) {
  const { data: snap, isLoading, error } = useQuery<ValuationSnapshot>({
    queryKey: ["valuation", ticker],
    queryFn: () =>
      fetch(`/api/analysis/securities/valuation?ticker=${encodeURIComponent(ticker)}`).then((r) => {
        if (!r.ok) throw new Error(`Valuation fetch failed (${r.status})`);
        return r.json();
      }),
    staleTime: 60 * 60_000, // components are EOD — refetch at most hourly per mount
    refetchOnWindowFocus: false,
  });

  // Same key as StockPriceChart's 1D query — React Query dedupes the fetch;
  // this observer supplies the live polling during market sessions.
  const { data: series } = useQuery<PriceSeriesResult>({
    queryKey: ["price-series", ticker, "1D"],
    queryFn: () =>
      fetch(`/api/analysis/securities/price-series?ticker=${encodeURIComponent(ticker)}&range=1D`).then(
        (r) => r.json(),
      ),
    staleTime: 30_000,
    refetchInterval: () => (getUsMarketSession(new Date()) !== "CLOSED" ? 20_000 : false),
  });

  const labelStyle: CSSProperties = {
    fontSize: 9,
    color: "var(--text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  };

  if (isLoading) {
    return (
      <div>
        <div style={labelStyle}>Enterprise value ($M)</div>
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>Loading valuation…</div>
      </div>
    );
  }
  if (error || !snap) {
    return (
      <div>
        <div style={labelStyle}>Enterprise value ($M)</div>
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>Valuation unavailable</div>
      </div>
    );
  }

  const lastPoint = series?.points?.length ? series.points[series.points.length - 1] : null;
  const livePrice = lastPoint?.price ?? snap.refPrice;

  const marketCap = snap.fdso !== null && livePrice !== null ? snap.fdso * livePrice : null;
  const tev =
    snap.kind === "company" && marketCap !== null
      ? marketCap +
        (snap.totalDebt ?? 0) -
        (snap.cash ?? 0) +
        (snap.preferredEquity ?? 0) +
        (snap.minorityInterest ?? 0)
      : null;

  const sharesLine =
    snap.fdso !== null && livePrice !== null
      ? `${fmtSharesM(snap.fdso)}M × $${fmtPrice(livePrice)}`
      : "—";

  if (snap.kind === "fund") {
    return (
      <div title="Fund / ETF — no capital structure or consensus estimates. Market cap = shares outstanding × live price.">
        <div style={labelStyle}>Market cap ($M)</div>
        <div style={{ marginTop: 4 }}>
          <BuildRow label={`Shares ${sharesLine}`} value="" muted />
          <BuildRow label="Market cap" value={formatStatement(marketCap, "millions")} bold topRule />
        </div>
        <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 6 }}>
          Fund/ETF — no capital structure / estimates
        </div>
      </div>
    );
  }

  const fyLabel = snap.fyPlus1.fiscalYearLabel ?? "FY+1";
  const showMultiples =
    snap.ntm.ebitda !== null ||
    snap.ntm.eps !== null ||
    snap.fyPlus1.ebitda !== null ||
    snap.fyPlus1.eps !== null;

  return (
    <div
      title={
        `Enterprise-value build.\n` +
        `FDSO (${snap.fdsoSource === "quote-shares" ? "basic shares from quote" : "diluted, latest quarterly filing"}) × live price = market cap; ` +
        `debt / cash / preferred / minority interest as of ${snap.balanceFiscalDate ?? "n/a"} (FMP, refreshed once per trading day).\n` +
        `Multiples: TEV/EBITDA and P/E on NTM (${snap.ntm.basis === "annual-blend" ? "calendar-weighted FY1/FY2 blend" : "sum of next 4 quarterly consensus periods"}) ` +
        `and ${fyLabel} (fiscal year after the current unreported one). Numerators tick with the live price; denominators are EOD.`
      }
    >
      <div style={labelStyle}>Enterprise value ($M)</div>
      <div style={{ marginTop: 3 }}>
        <BuildRow label={`FDSO ${sharesLine}`} value="" muted />
        <BuildRow label="Market cap" value={formatStatement(marketCap, "millions")} bold />
        <BuildRow label="+ Total debt" value={formatStatement(snap.totalDebt, "millions")} />
        <BuildRow label="− Cash" value={formatStatement(snap.cash, "millions")} />
        <BuildRow label="+ Preferred equity" value={formatStatement(snap.preferredEquity, "millions")} />
        <BuildRow label="+ Minority interest" value={formatStatement(snap.minorityInterest, "millions")} />
        <BuildRow label="TEV" value={formatStatement(tev, "millions")} bold topRule />
      </div>

      {showMultiples && (
        <div style={{ marginTop: 8 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto auto",
              columnGap: 14,
              rowGap: 1,
              alignItems: "baseline",
            }}
          >
            <span style={{ ...labelStyle, letterSpacing: "0.06em" }}>Multiples</span>
            <span style={{ ...labelStyle, letterSpacing: "0.06em", textAlign: "right" }}>NTM</span>
            <span style={{ ...labelStyle, letterSpacing: "0.06em", textAlign: "right" }}>{fyLabel}</span>

            <span style={{ fontSize: 10, color: "var(--text-secondary, var(--text-muted))" }}>TEV/EBITDA</span>
            <span style={{ fontSize: 11, fontFamily: MONO, fontVariantNumeric: "tabular-nums", textAlign: "right", color: "var(--text-primary)" }}>
              {multipleText(tev, snap.ntm.ebitda)}
            </span>
            <span style={{ fontSize: 11, fontFamily: MONO, fontVariantNumeric: "tabular-nums", textAlign: "right", color: "var(--text-primary)" }}>
              {multipleText(tev, snap.fyPlus1.ebitda)}
            </span>

            <span style={{ fontSize: 10, color: "var(--text-secondary, var(--text-muted))" }}>P/E</span>
            <span style={{ fontSize: 11, fontFamily: MONO, fontVariantNumeric: "tabular-nums", textAlign: "right", color: "var(--text-primary)" }}>
              {multipleText(livePrice, snap.ntm.eps)}
            </span>
            <span style={{ fontSize: 11, fontFamily: MONO, fontVariantNumeric: "tabular-nums", textAlign: "right", color: "var(--text-primary)" }}>
              {multipleText(livePrice, snap.fyPlus1.eps)}
            </span>
          </div>
          {snap.ntm.basis === "annual-blend" && (
            <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 3 }}>
              NTM = calendar-weighted FY blend (quarterly consensus incomplete)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
