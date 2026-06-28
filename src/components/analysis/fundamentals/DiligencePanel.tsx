"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { robustDomain } from "@/lib/fundamental/robust-domain";

interface DiligenceResult {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  subsector: string | null;
  snapshotDate: string | null;
  latest: Record<string, number | null>;
  score: Record<string, unknown> | null;
  series: {
    dates: string[];
    ttmGrossMargin: Array<number | null>;
    ttmEbitdaMargin: Array<number | null>;
    ttmNetMargin: Array<number | null>;
    revenueGrowthYoy: Array<number | null>;
    roic: Array<number | null>;
    netDebtToEbitda: Array<number | null>;
    peRatio: Array<number | null>;
    evToEbitda: Array<number | null>;
    priceToSales: Array<number | null>;
  };
}

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`;
}
function num(v: number | null | undefined, d = 2): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(d);
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title} style={{ background: "var(--bg-surface)", border: "1px solid var(--chrome-border)", padding: "4px 8px", minWidth: 92 }}>
      <div style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }} className="bb-num">{value}</div>
    </div>
  );
}

export function DiligencePanel({
  ticker,
  onPickTicker,
}: {
  ticker: string | null;
  onPickTicker: (t: string) => void;
}) {
  const [input, setInput] = useState(ticker ?? "");

  const { data, isLoading, error } = useQuery<DiligenceResult>({
    queryKey: ["fundamentals-diligence", ticker],
    enabled: !!ticker,
    queryFn: async () => {
      const r = await fetch(`/api/analysis/fundamentals/diligence?ticker=${encodeURIComponent(ticker!)}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).reason ?? "Failed");
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  const marginData = (data?.series.dates ?? []).map((d, i) => ({
    date: d,
    gross: data!.series.ttmGrossMargin[i] != null ? (data!.series.ttmGrossMargin[i] as number) * 100 : null,
    ebitda: data!.series.ttmEbitdaMargin[i] != null ? (data!.series.ttmEbitdaMargin[i] as number) * 100 : null,
    net: data!.series.ttmNetMargin[i] != null ? (data!.series.ttmNetMargin[i] as number) * 100 : null,
  }));
  // Clip the margin axis to the name's own bulk so a pre-revenue spike (e.g. a
  // -42,000% early quarter) can't squash the readable recent trajectory. The
  // line clips at the edges via allowDataOverflow rather than distorting shape.
  const marginDomain = robustDomain(
    marginData.flatMap((d) => [d.gross, d.ebitda, d.net]),
  );

  const valuation = (data?.score?.valuation ?? null) as
    | { cheapness: number | null; peRatio: number | null; evToEbitda: number | null; priceToSales: number | null }
    | null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
        <span style={{ color: "var(--text-muted)" }}>Ticker</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === "Enter" && input.trim()) onPickTicker(input.trim()); }}
          placeholder="e.g. AAPL"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--chrome-border)", color: "var(--text-primary)", fontSize: 11, padding: "2px 6px", width: 100 }}
        />
        <button type="button" className="bb-tab" style={{ border: "1px solid var(--chrome-border)" }} onClick={() => input.trim() && onPickTicker(input.trim())}>
          Show
        </button>
        {data ? <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>{data.ticker}</span> : null}
        {data?.companyName ? <span style={{ color: "var(--text-muted)" }}>{data.companyName} · {data.subsector ?? data.sector ?? "—"}</span> : null}
      </div>

      {!ticker ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>
          Pick a name from any discovery view, or type one above. The diligence panel shows the margin trajectory,
          quality metrics, and each multiple in its own 5-year percentile range.
        </div>
      ) : isLoading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>Loading diligence…</div>
      ) : error || !data ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>No fundamentals stored for {ticker} yet.</div>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <Metric label="Rev TTM" value={data.latest.revenueTtm != null ? `${(data.latest.revenueTtm / 1e9).toFixed(2)}B` : "—"} />
            <Metric label="Gross M" value={pct(data.latest.grossMargin)} />
            <Metric label="EBITDA M" value={pct(data.latest.ebitdaMargin)} />
            <Metric label="Net M" value={pct(data.latest.netMargin)} />
            <Metric label="Rev YoY" value={pct(data.latest.revenueGrowthYoy)} />
            <Metric label="ROIC" value={pct(data.latest.roic)} />
            <Metric label="FCF M" value={pct(data.latest.fcfMargin)} />
            <Metric label="NetDebt/EBITDA" value={num(data.latest.netDebtToEbitda)} />
            <Metric label="Accruals" value={num(data.latest.accrualsRatio, 3)} title="Sloan-style (NI − OCF)/avg assets. Higher = lower earnings quality." />
          </div>

          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>TTM margin trajectory (%)</div>
            <div style={{ height: 260, background: "var(--bg-surface)", padding: 6 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={marginData} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                  <CartesianGrid stroke="var(--chrome-border)" strokeDasharray="2 2" />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: "var(--text-muted)" }} />
                  <YAxis tick={{ fontSize: 9, fill: "var(--text-muted)" }} {...(marginDomain ? { domain: marginDomain, allowDataOverflow: true } : {})} />
                  <Tooltip contentStyle={{ background: "var(--bg-base)", border: "1px solid var(--chrome-border)", fontSize: 11 }} labelStyle={{ color: "var(--text-muted)" }} />
                  <Line type="monotone" dataKey="gross" name="Gross" stroke="var(--color-accent)" dot={false} connectNulls />
                  <Line type="monotone" dataKey="ebitda" name="EBITDA" stroke="var(--color-positive)" dot={false} connectNulls />
                  <Line type="monotone" dataKey="net" name="Net" stroke="#5aa0ff" dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Valuation vs own 5y history (percentile; lower = cheaper)</div>
              <table className="bb-table" style={{ fontSize: 11, borderCollapse: "collapse" }}>
                <tbody>
                  <ValRow label="P/E" current={data.latest.peRatio} pctile={valuation?.peRatio ?? null} />
                  <ValRow label="EV/EBITDA" current={data.latest.evToEbitda} pctile={valuation?.evToEbitda ?? null} />
                  <ValRow label="P/Sales" current={data.latest.priceToSales} pctile={valuation?.priceToSales ?? null} />
                  <tr style={{ borderTop: "1px solid var(--chrome-border)" }}>
                    <td style={{ padding: "2px 8px", color: "var(--text-muted)" }}>Blended cheapness</td>
                    <td style={{ padding: "2px 8px", textAlign: "right", fontWeight: 700, color: "var(--text-primary)" }} className="bb-num">{num(valuation?.cheapness ?? null)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ValRow({ label, current, pctile }: { label: string; current: number | null; pctile: number | null }) {
  return (
    <tr style={{ borderTop: "1px solid var(--chrome-border)" }}>
      <td style={{ padding: "2px 8px", color: "var(--text-muted)" }}>{label}</td>
      <td style={{ padding: "2px 8px", textAlign: "right" }} className="bb-num">{current == null || !Number.isFinite(current) ? "—" : current.toFixed(1)}x</td>
      <td style={{ padding: "2px 8px", textAlign: "right", color: pctile == null ? "var(--text-muted)" : pctile <= 0.3 ? "var(--color-positive)" : pctile >= 0.7 ? "var(--bb-red)" : "var(--text-primary)" }} className="bb-num">
        {pctile == null ? "—" : `${(pctile * 100).toFixed(0)}th`}
      </td>
    </tr>
  );
}
