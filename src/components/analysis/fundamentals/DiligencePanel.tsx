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
import { heatSignedBloomberg } from "@/components/analysis/ui/heat";
import { InfoTooltip, type InfoTooltipProps } from "@/components/analysis/ui/InfoTooltip";
import { bbAxisTick, bbAxisLine, bbChartTitle, bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import { fmtSmartMoney, fmtPctWhole, fmtMultiple, fmtPctFromPct } from "@/lib/format";
import type { FundamentalScoreJson, BoxAudit } from "./types";

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

function num(v: number | null | undefined, d = 2): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(d);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** ISO date "2025-09-30" → "Sep '25" for compact axis/tooltip labels. */
function fmtQuarterLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const mon = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${mon} '${m[1].slice(2)}`;
}

/** Per-metric explainer copy for the box ⓘ popovers. */
const METRIC_INFO: Record<string, Omit<InfoTooltipProps, "currentValue" | "passing">> = {
  revenueTtm: {
    name: "Revenue (TTM)",
    definition: "Trailing-twelve-month total revenue — the sum of the last four reported quarters.",
    dataUsed: "FMP income statement, last 4 quarters.",
  },
  grossMargin: {
    name: "Gross Margin",
    definition: "Share of revenue left after the direct cost of goods/services.",
    formula: "(Revenue − COGS) / Revenue",
    dataUsed: "TTM gross profit ÷ TTM revenue.",
  },
  ebitdaMargin: {
    name: "EBITDA Margin",
    definition: "Operating profitability before interest, tax, depreciation and amortization, as a share of revenue.",
    formula: "EBITDA / Revenue",
    dataUsed: "TTM EBITDA ÷ TTM revenue.",
  },
  netMargin: {
    name: "Net Margin",
    definition: "Bottom-line profit as a share of revenue.",
    formula: "Net Income / Revenue",
    dataUsed: "TTM net income ÷ TTM revenue.",
  },
  revenueGrowthYoy: {
    name: "Revenue Growth (YoY)",
    definition: "Year-over-year change in TTM revenue versus the same period one year earlier.",
    formula: "(Rev_TTM / Rev_TTM_1yr_ago) − 1",
    dataUsed: "Current vs year-ago TTM revenue.",
  },
  roic: {
    name: "Return on Invested Capital",
    definition: "After-tax operating profit earned per dollar of capital put to work — a core quality/compounding gauge.",
    formula: "NOPAT / Invested Capital",
    dataUsed: "TTM NOPAT ÷ (debt + equity − cash).",
  },
  fcfMargin: {
    name: "Free-Cash-Flow Margin",
    definition: "Free cash flow generated per dollar of revenue.",
    formula: "(Operating CF − CapEx) / Revenue",
    dataUsed: "TTM free cash flow ÷ TTM revenue.",
  },
  netDebtToEbitda: {
    name: "Net Debt / EBITDA",
    definition: "Leverage: how many years of EBITDA it would take to repay net debt. Lower is safer; negative means net cash.",
    formula: "(Total Debt − Cash) / EBITDA",
    dataUsed: "Latest balance sheet debt & cash ÷ TTM EBITDA.",
    goodValue: "< 3.0x for most businesses.",
  },
  accrualsRatio: {
    name: "Accruals (Sloan)",
    definition: "Earnings-quality check: how much of reported profit is NOT backed by cash. Higher (more positive) = lower quality; investors should be wary of profits that don't convert to cash.",
    formula: "(Net Income − Operating CF) / avg Total Assets",
    dataUsed: "TTM net income, TTM operating cash flow, trailing-average total assets.",
    goodValue: "Near zero or negative (cash-backed earnings).",
  },
};

function Metric({
  label,
  value,
  metricKey,
  currentValue,
}: {
  label: string;
  value: string;
  metricKey: keyof typeof METRIC_INFO;
  currentValue?: string;
}) {
  const info = METRIC_INFO[metricKey];
  return (
    <div style={{ background: "var(--bg-surface)", border: "1px solid var(--chrome-border)", padding: "4px 8px", minWidth: 92 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        <div style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
        {info ? <InfoTooltip {...info} currentValue={currentValue ?? value} /> : null}
      </div>
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
  // Margin ratios for pre-revenue names can be astronomical (e.g. a quarter with
  // near-zero revenue gives a net margin of millions of percent), which would
  // squash the readable recent trajectory. Clamp the axis to ±1000% and let the
  // lines clip at the edges (allowDataOverflow) rather than distorting shape.
  const MARGIN_CLAMP = 1000;
  const rawMax = Math.max(
    0,
    ...marginData.flatMap((d) => [d.gross, d.ebitda, d.net]).filter((v): v is number => v != null && Number.isFinite(v)).map((v) => Math.abs(v)),
  );
  const bound = Math.min(MARGIN_CLAMP, Math.max(50, Math.ceil(rawMax / 25) * 25));
  const marginDomain: [number, number] = [-bound, bound];

  const valuation = (data?.score?.valuation ?? null) as
    | { cheapness: number | null; peRatio: number | null; evToEbitda: number | null; priceToSales: number | null }
    | null;
  const scoreJson = (data?.score ?? null) as unknown as FundamentalScoreJson | null;

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
            <Metric label="Rev TTM" metricKey="revenueTtm" value={fmtSmartMoney(data.latest.revenueTtm)} />
            <Metric label="Gross M" metricKey="grossMargin" value={fmtPctWhole(data.latest.grossMargin)} />
            <Metric label="EBITDA M" metricKey="ebitdaMargin" value={fmtPctWhole(data.latest.ebitdaMargin)} />
            <Metric label="Net M" metricKey="netMargin" value={fmtPctWhole(data.latest.netMargin)} />
            <Metric label="Rev YoY" metricKey="revenueGrowthYoy" value={fmtPctWhole(data.latest.revenueGrowthYoy)} />
            <Metric label="ROIC" metricKey="roic" value={fmtPctWhole(data.latest.roic)} />
            <Metric label="FCF M" metricKey="fcfMargin" value={fmtPctWhole(data.latest.fcfMargin)} />
            <Metric label="NetDebt/EBITDA" metricKey="netDebtToEbitda" value={fmtMultiple(data.latest.netDebtToEbitda)} />
            <Metric label="Accruals" metricKey="accrualsRatio" value={num(data.latest.accrualsRatio, 3)} />
          </div>

          <div>
            <div style={{ ...bbChartTitle, marginBottom: 4 }}>TTM Margin Trajectory (%)</div>
            <div style={{ height: 260, background: "var(--bg-surface)", padding: 6 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={marginData} margin={{ top: 8, right: 16, bottom: 18, left: 4 }}>
                  <CartesianGrid stroke="var(--chrome-border)" strokeDasharray="2 2" />
                  <XAxis
                    dataKey="date"
                    tick={bbAxisTick}
                    axisLine={bbAxisLine}
                    tickLine={bbAxisLine}
                    tickFormatter={fmtQuarterLabel}
                    label={{ value: "Fiscal quarter end", position: "insideBottom", offset: -8, fill: "var(--color-accent)", fontSize: 11 }}
                  />
                  <YAxis
                    tick={bbAxisTick}
                    axisLine={bbAxisLine}
                    tickLine={bbAxisLine}
                    domain={marginDomain}
                    allowDataOverflow
                    tickFormatter={(v: number) => fmtPctFromPct(v)}
                    width={48}
                    label={{ value: "Margin (%)", angle: -90, position: "insideLeft", fill: "var(--color-accent)", fontSize: 11, style: { textAnchor: "middle" } }}
                  />
                  <Tooltip
                    contentStyle={bbTooltipStyle}
                    labelStyle={{ color: "var(--text-muted)" }}
                    labelFormatter={(l) => fmtQuarterLabel(String(l))}
                    formatter={(value, name) => [fmtPctFromPct(Number(value)), String(name)]}
                  />
                  <Line type="monotone" dataKey="gross" name="Gross" stroke="var(--color-accent)" dot={false} connectNulls />
                  <Line type="monotone" dataKey="ebitda" name="EBITDA" stroke="var(--color-positive)" dot={false} connectNulls />
                  <Line type="monotone" dataKey="net" name="Net" stroke="#5aa0ff" dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {scoreJson?.boxes && scoreJson.boxes.length > 0 ? <BoxBreakdown score={scoreJson} /> : null}

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

/** Auditable per-box breakdown: box score + each component's raw value and peer z. */
function BoxBreakdown({ score }: { score: FundamentalScoreJson }) {
  const composite = score.composite;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, flexWrap: "wrap" }}>
        <span style={{ color: "var(--text-muted)" }}>Box scores (peer-relative z, mean of components)</span>
        <span style={{ color: composite != null ? heatSignedBloomberg(composite, 1.5) : "var(--text-muted)", fontWeight: 700 }} className="bb-num">
          Composite {composite != null ? composite.toFixed(2) : "—"}
        </span>
        <span style={{ color: "var(--text-muted)" }}>{score.validBoxCount}/9 valid boxes</span>
        {score.scoreMethodologyVersion ? (
          <span style={{ color: "var(--text-muted)", fontSize: 9 }}>{score.scoreMethodologyVersion}</span>
        ) : null}
      </div>
      {score.flags && score.flags.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {score.flags.map((f) => (
            <span key={f} style={{ fontSize: 9, fontWeight: 700, color: "#000", background: "var(--color-accent)", padding: "0 4px", opacity: 0.9 }}>
              {f}
            </span>
          ))}
        </div>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 6 }}>
        {score.boxes.map((box) => (
          <BoxCard key={box.key} box={box} />
        ))}
      </div>
    </div>
  );
}

function BoxCard({ box }: { box: BoxAudit }) {
  const color = box.boxScore != null ? heatSignedBloomberg(box.boxScore, 1.5) : "var(--text-muted)";
  return (
    <div style={{ background: "var(--bg-surface)", border: "1px solid var(--chrome-border)", padding: "4px 8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-primary)" }}>{box.label}</span>
        <span className="bb-num" style={{ fontSize: 12, fontWeight: 700, color }}>
          {box.boxScore != null ? box.boxScore.toFixed(2) : "—"}
        </span>
      </div>
      {box.boxScore == null && box.missingReason ? (
        <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>{box.missingReason}</div>
      ) : (
        <table style={{ width: "100%", fontSize: 10, borderCollapse: "collapse", marginTop: 2 }}>
          <thead>
            <tr style={{ color: "var(--text-muted)" }}>
              <th style={{ textAlign: "left", fontWeight: 400 }}>Component</th>
              <th style={{ textAlign: "right", fontWeight: 400 }}>raw</th>
              <th style={{ textAlign: "right", fontWeight: 400 }}>z</th>
            </tr>
          </thead>
          <tbody>
            {box.components.map((c) => (
              <tr key={c.key}>
                <td style={{ color: "var(--text-muted)", paddingRight: 4 }}>{c.label}</td>
                <td className="bb-num" style={{ textAlign: "right", color: "var(--text-primary)" }}>
                  {c.raw == null || !Number.isFinite(c.raw) ? "—" : Math.abs(c.raw) >= 1000 ? c.raw.toExponential(1) : c.raw.toFixed(3)}
                </td>
                <td
                  className="bb-num"
                  style={{ textAlign: "right", color: c.z != null && Number.isFinite(c.z) ? heatSignedBloomberg(c.z, 2) : "var(--text-muted)" }}
                >
                  {c.z == null || !Number.isFinite(c.z) ? "—" : c.z.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
