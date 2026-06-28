"use client";

import { Fragment, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkline } from "@/components/analysis/ui/Sparkline";
import type { FaBasis, FaSparkSeries, FaUnit } from "@/lib/fundamental/financials";
import {
  formatGrowthPct,
  formatMarginPct,
  formatMultiple,
  formatPerShare,
  formatStatement,
  unitLabel,
} from "@/lib/fundamental/format-statement";

type FaColumn = FinancialsResult["columns"][number];

interface FinancialsResult {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  subsector: string | null;
  basis: FaBasis;
  currency: string | null;
  snapshotDate: string | null;
  unit: FaUnit;
  columns: Array<{
    kind: "period" | "current" | "estimate";
    label: string;
    fiscalDate: string | null;
    analysts: number | null;
  }>;
  income: Array<{
    key: string;
    label: string;
    values: Array<number | null>;
    spark: FaSparkSeries;
    sub: {
      key: string;
      label: string;
      kind: "margin" | "growth";
      values: Array<number | null>;
      spark: FaSparkSeries;
    } | null;
  }>;
  perShare: Array<{ key: string; label: string; values: Array<number | null>; spark: FaSparkSeries }>;
  bridge: Array<{ key: string; label: string; sign: "+" | "-" | "="; values: Array<number | null>; spark: FaSparkSeries }>;
  valuationMetrics: Array<{
    key: string;
    label: string;
    kind: "multiple" | "percent";
    values: Array<number | null>;
    spark: FaSparkSeries;
  }>;
  returnMetrics: Array<{
    key: string;
    label: string;
    kind: "multiple" | "percent";
    values: Array<number | null>;
    spark: FaSparkSeries;
  }>;
}

class FinancialsFetchError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "FinancialsFetchError";
  }
}

const UNIT_OPTIONS: Array<{ key: FaUnit | "auto"; label: string }> = [
  { key: "auto", label: "Auto" },
  { key: "thousands", label: "Thousands" },
  { key: "millions", label: "Millions" },
  { key: "billions", label: "Billions" },
];

const LABEL_COL_WIDTH = 196;
const VALUE_COL_WIDTH = 92;
const SPARK_COL_WIDTH = 56;

function valueColor(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "var(--text-muted)";
  return v < 0 ? "var(--color-negative)" : "var(--text-primary)";
}

function sparkInsertIndex(cols: FaColumn[]): number {
  const ltm = cols.findIndex((c) => c.kind === "current");
  if (ltm >= 0) return ltm;
  let lastPeriod = -1;
  for (let i = 0; i < cols.length; i++) {
    if (cols[i]!.kind === "period") lastPeriod = i;
  }
  return lastPeriod;
}

function sparkSeriesForChart(spark: FaSparkSeries): number[] {
  return spark.filter((v): v is number => v !== null && Number.isFinite(v));
}

function sparkPositive(spark: FaSparkSeries): boolean | undefined {
  const data = sparkSeriesForChart(spark);
  if (data.length < 2) return undefined;
  return data[data.length - 1]! >= data[0]!;
}

function SparklineCell({ spark }: { spark: FaSparkSeries }) {
  const data = sparkSeriesForChart(spark);
  return (
    <td
      className="bb-fa-spark-col"
      style={{
        textAlign: "center",
        padding: "0 2px",
        minWidth: SPARK_COL_WIDTH,
        borderLeft: "1px solid var(--chrome-border)",
      }}
    >
      <Sparkline data={data} positive={sparkPositive(spark)} height={18} width={52} />
    </td>
  );
}

function renderDataCells(
  values: Array<number | null>,
  spark: FaSparkSeries,
  cols: FaColumn[],
  format: (v: number | null) => string,
  tdStyle?: (v: number | null, kind: FaColumn["kind"]) => CSSProperties,
) {
  const insertAt = sparkInsertIndex(cols);
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < cols.length; i++) {
    const kind = cols[i]!.kind;
    const v = values[i] ?? null;
    cells.push(
      <td key={i} style={{ ...cellStyle(kind), ...tdStyle?.(v, kind) }} className="bb-num">
        {format(v)}
      </td>,
    );
    if (i === insertAt) {
      cells.push(<SparklineCell key="spark" spark={spark} />);
    }
  }
  return cells;
}

export function FinancialsTable({
  ticker,
  onPickTicker,
}: {
  ticker: string | null;
  onPickTicker: (t: string) => void;
}) {
  const [input, setInput] = useState(ticker ?? "");
  const [basis, setBasis] = useState<FaBasis>("quarter");
  const [unitOverride, setUnitOverride] = useState<FaUnit | "auto">("auto");

  const { data, isLoading, error } = useQuery<FinancialsResult, FinancialsFetchError>({
    queryKey: ["fundamentals-financials", ticker, basis],
    enabled: !!ticker,
    queryFn: async () => {
      const r = await fetch(
        `/api/analysis/fundamentals/financials?ticker=${encodeURIComponent(ticker!)}&basis=${basis}`,
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { reason?: string };
        throw new FinancialsFetchError(r.status, body.reason ?? `Request failed (${r.status})`);
      }
      return r.json();
    },
    retry: false,
    staleTime: 5 * 60_000,
  });

  const unit: FaUnit = unitOverride === "auto" ? (data?.unit ?? "millions") : unitOverride;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, flexWrap: "wrap" }}>
        <span style={{ color: "var(--text-muted)" }}>Ticker</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) onPickTicker(input.trim());
          }}
          placeholder="e.g. AAPL"
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--chrome-border)",
            color: "var(--text-primary)",
            fontSize: 11,
            padding: "2px 6px",
            width: 100,
          }}
        />
        <button
          type="button"
          className="bb-tab"
          style={{ border: "1px solid var(--chrome-border)" }}
          onClick={() => input.trim() && onPickTicker(input.trim())}
        >
          Show
        </button>

        <div style={{ display: "flex", border: "1px solid var(--chrome-border)" }}>
          {(["annual", "quarter"] as FaBasis[]).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBasis(b)}
              className="bb-tab"
              style={{
                border: "none",
                background: basis === b ? "var(--color-accent)" : "transparent",
                color: basis === b ? "#000" : "var(--text-muted)",
                fontWeight: basis === b ? 700 : 400,
              }}
            >
              {b === "annual" ? "Annual" : "Quarterly"}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ color: "var(--text-muted)" }}>Units</span>
          <select
            value={unitOverride}
            onChange={(e) => setUnitOverride(e.target.value as FaUnit | "auto")}
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--chrome-border)",
              color: "var(--text-primary)",
              fontSize: 11,
              padding: "2px 4px",
            }}
          >
            {UNIT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {data ? <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>{data.ticker}</span> : null}
        {data?.companyName ? (
          <span style={{ color: "var(--text-muted)" }}>
            {data.companyName} · {data.subsector ?? data.sector ?? "—"}
          </span>
        ) : null}
      </div>

      {!ticker ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>
          Pick a name from any discovery view, or type one above. The Financials view shows the historical income
          statement (Revenue → Gross Profit → EBITDA → Net Income → CFFO → CAPEX → FCF) with margins, a per-share build,
          and the Market Cap → Enterprise Value bridge.
        </div>
      ) : isLoading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>Loading financials…</div>
      ) : error && error.status !== 404 ? (
        <div style={{ color: "var(--color-negative)", fontSize: 11, padding: 12 }}>
          Couldn&apos;t load financials for {ticker} (server error). {error.message}
        </div>
      ) : error || !data ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>No fundamentals stored for {ticker} yet.</div>
      ) : (
        <StatementGrid data={data} unit={unit} />
      )}
    </div>
  );
}

const ESTIMATE_BG = "color-mix(in srgb, var(--color-accent) 8%, transparent)";

function StatementGrid({ data, unit }: { data: FinancialsResult; unit: FaUnit }) {
  const cols = data.columns;
  const estimateCount = cols.filter((c) => c.kind === "estimate").length;
  const sparkAt = sparkInsertIndex(cols);
  const beforeSparkCount = sparkAt >= 0 ? sparkAt + 1 : cols.length;
  const totalDataCols = cols.length + 1;

  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--chrome-border)", background: "var(--bg-base)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "4px 8px",
          borderBottom: "1px solid var(--chrome-border)",
          background: "var(--bg-surface)",
        }}
      >
        <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>
          {unitLabel(unit)}
          {data.currency && data.currency !== "USD" ? ` (reported ${data.currency})` : ""}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
          {data.basis === "annual" ? "Fiscal year" : "Fiscal quarter"}
          {data.snapshotDate ? ` · priced ${data.snapshotDate}` : ""}
        </span>
      </div>

      <table
        style={{
          borderCollapse: "collapse",
          fontSize: 11,
          minWidth: LABEL_COL_WIDTH + cols.length * VALUE_COL_WIDTH + SPARK_COL_WIDTH,
        }}
      >
        <thead>
          {estimateCount > 0 ? (
            <tr>
              <th
                style={{
                  position: "sticky",
                  left: 0,
                  zIndex: 1,
                  background: "var(--bg-surface)",
                  borderBottom: "1px solid var(--chrome-border)",
                }}
              />
              {beforeSparkCount > 0 ? (
                <th colSpan={beforeSparkCount} style={{ background: "var(--bg-surface)" }} />
              ) : null}
              <th
                style={{
                  background: "var(--bg-surface)",
                  borderBottom: "1px solid var(--chrome-border)",
                  minWidth: SPARK_COL_WIDTH,
                }}
              />
              <th
                colSpan={estimateCount}
                style={{
                  textAlign: "center",
                  padding: "3px 8px",
                  background: ESTIMATE_BG,
                  color: "var(--color-accent)",
                  fontWeight: 700,
                  fontSize: 9,
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                  borderLeft: "1px solid var(--color-accent)",
                  borderBottom: "1px solid var(--chrome-border)",
                  whiteSpace: "nowrap",
                }}
              >
                Consensus Estimates
              </th>
            </tr>
          ) : null}
          <tr>
            <th
              style={{
                position: "sticky",
                left: 0,
                zIndex: 1,
                background: "var(--bg-surface)",
                textAlign: "left",
                padding: "4px 8px",
                minWidth: LABEL_COL_WIDTH,
                borderBottom: "1px solid var(--chrome-border)",
              }}
            />
            {cols.map((c, i) => (
              <Fragment key={i}>
                <th
                  style={{
                    textAlign: "right",
                    padding: "4px 8px",
                    minWidth: VALUE_COL_WIDTH,
                    borderBottom: "1px solid var(--chrome-border)",
                    borderLeft: c.kind !== "period" ? "1px solid var(--chrome-border)" : undefined,
                    background: c.kind === "estimate" ? ESTIMATE_BG : undefined,
                    color: c.kind === "period" ? "var(--text-primary)" : "var(--color-accent)",
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                  title={c.fiscalDate ?? undefined}
                >
                  {c.label}
                  {c.kind === "estimate" ? (
                    <div style={{ fontSize: 9, fontWeight: 400, color: "var(--text-muted)" }}>
                      {c.analysts != null ? `n=${c.analysts}` : "\u00a0"}
                    </div>
                  ) : null}
                </th>
                {i === sparkAt ? (
                  <th
                    style={{
                      textAlign: "center",
                      padding: "4px 4px",
                      minWidth: SPARK_COL_WIDTH,
                      borderBottom: "1px solid var(--chrome-border)",
                      borderLeft: "1px solid var(--chrome-border)",
                      color: "var(--text-muted)",
                      fontWeight: 600,
                      fontSize: 9,
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                      whiteSpace: "nowrap",
                    }}
                  >
                    Trend
                  </th>
                ) : null}
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          <SectionHeader label="Income Statement" span={totalDataCols + 1} />
          {data.income.map((row) => (
            <IncomeRow key={row.key} row={row} cols={cols} unit={unit} />
          ))}

          <SectionHeader label="Per Share" span={totalDataCols + 1} />
          {data.perShare.map((row) => (
            <tr key={row.key}>
              <RowLabel label={row.label} />
              {renderDataCells(row.values, row.spark, cols, formatPerShare)}
            </tr>
          ))}

          <SectionHeader label="Valuation" span={totalDataCols + 1} />
          {data.bridge.map((row) => {
            const isEv = row.key === "enterpriseValue";
            return (
              <tr key={row.key} style={isEv ? { borderTop: "1px solid var(--chrome-border)" } : undefined}>
                <td
                  style={{
                    position: "sticky",
                    left: 0,
                    background: "var(--bg-base)",
                    textAlign: "left",
                    padding: "3px 8px",
                    color: isEv ? "var(--text-primary)" : "var(--text-muted)",
                    fontWeight: isEv ? 700 : 400,
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.sign !== "=" ? <span style={{ color: "var(--text-muted)", marginRight: 4 }}>{row.sign}</span> : null}
                  {row.label}
                </td>
                {renderDataCells(row.values, row.spark, cols, (v) => formatStatement(v, unit), (v) => ({
                  color: valueColor(v),
                  fontWeight: isEv ? 700 : 400,
                }))}
              </tr>
            );
          })}

          {data.valuationMetrics.length > 0 ? (
            <>
              <SectionHeader label="Valuation Metrics" span={totalDataCols + 1} />
              {data.valuationMetrics.map((row) => (
                <MetricRow key={row.key} row={row} cols={cols} />
              ))}
            </>
          ) : null}

          {data.returnMetrics.length > 0 ? (
            <>
              <SectionHeader label="Return and Profitability Metrics" span={totalDataCols + 1} />
              {data.returnMetrics.map((row) => (
                <MetricRow key={row.key} row={row} cols={cols} />
              ))}
            </>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function IncomeRow({
  row,
  cols,
  unit,
}: {
  row: FinancialsResult["income"][number];
  cols: FinancialsResult["columns"];
  unit: FaUnit;
}) {
  return (
    <>
      <tr>
        <RowLabel label={row.label} bold />
        {renderDataCells(row.values, row.spark, cols, (v) => formatStatement(v, unit), (v) => ({
          color: valueColor(v),
          fontWeight: 600,
        }))}
      </tr>
      {row.sub ? (
        <tr>
          <td
            style={{
              position: "sticky",
              left: 0,
              background: "var(--bg-base)",
              textAlign: "left",
              padding: "1px 8px 4px 18px",
              color: "var(--text-muted)",
              fontStyle: "italic",
              fontSize: 10,
              whiteSpace: "nowrap",
            }}
          >
            {row.sub.label}
          </td>
          {renderDataCells(
            row.sub.values,
            row.sub.spark,
            cols,
            (v) => (row.sub!.kind === "margin" ? formatMarginPct(v) : formatGrowthPct(v)),
            () => ({
              color: "var(--text-muted)",
              fontStyle: "italic",
              fontSize: 10,
              paddingTop: 1,
              paddingBottom: 4,
            }),
          )}
        </tr>
      ) : null}
    </>
  );
}

function MetricRow({
  row,
  cols,
}: {
  row: FinancialsResult["valuationMetrics"][number];
  cols: FinancialsResult["columns"];
}) {
  return (
    <tr>
      <RowLabel label={row.label} />
      {renderDataCells(row.values, row.spark, cols, (v) =>
        row.kind === "percent" ? formatMarginPct(v) : formatMultiple(v),
      (v) => ({
        color: row.kind === "percent" ? valueColor(v) : v === null ? "var(--text-muted)" : "var(--text-primary)",
      }))}
    </tr>
  );
}

function SectionHeader({ label, span }: { label: string; span: number }) {
  return (
    <tr>
      <td
        colSpan={span}
        style={{
          background: "var(--bg-surface)",
          color: "var(--color-accent)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          fontWeight: 700,
          fontSize: 10,
          padding: "5px 8px",
          borderTop: "1px solid var(--chrome-border)",
          borderBottom: "1px solid var(--chrome-border)",
        }}
      >
        {label}
      </td>
    </tr>
  );
}

function RowLabel({ label, bold }: { label: string; bold?: boolean }) {
  return (
    <td
      style={{
        position: "sticky",
        left: 0,
        background: "var(--bg-base)",
        textAlign: "left",
        padding: "3px 8px",
        color: "var(--text-primary)",
        fontWeight: bold ? 600 : 400,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </td>
  );
}

function cellStyle(kind: "period" | "current" | "estimate"): CSSProperties {
  return {
    textAlign: "right",
    padding: "3px 8px",
    minWidth: VALUE_COL_WIDTH,
    borderLeft: kind !== "period" ? "1px solid var(--chrome-border)" : undefined,
    background: kind === "estimate" ? ESTIMATE_BG : undefined,
    whiteSpace: "nowrap",
  };
}
