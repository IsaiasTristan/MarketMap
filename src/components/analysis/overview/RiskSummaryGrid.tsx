"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { Sparkline } from "@/components/analysis/ui/Sparkline";
import {
  BB_GRID_FONT_STACK,
  BB_GRID_HEADER_BG,
  BB_GRID_HEADER_FONT_SIZE,
  BB_GRID_HEADER_FONT_WEIGHT,
  BB_GRID_HEADER_LETTER_SPACING,
} from "@/components/analysis/factors/shared/bloomberg-grid";
import {
  annualToDailyVol,
  fmtBbLossPct,
  fmtBbShareVolDollar,
  fmtBbVolPct1d,
  fmtBbWholeDollar,
  fmtPrice,
  fmtWeightPct,
} from "@/components/analysis/overview/formatters";
import { WeightDataBarCell } from "@/components/analysis/overview/WeightDataBarCell";
import { sortByAbsDollarDesc } from "@/lib/holdings/sort-chart-grid";
import { heatVolClassification } from "@/domain/calculations/heatmap";
import type { PositionRisk } from "@/server/services/risk.service";

const ACCENT = "var(--color-accent)";
const CYAN = "var(--color-cyan)";
const MUTED = "var(--text-secondary)";
const VOL_HEADER = "#fff";
const POSITIVE = "var(--color-positive)";
const NEGATIVE = "var(--color-negative)";

const btnFlat = {
  padding: "3px 8px",
  borderRadius: 0,
  border: "1px solid var(--chrome-border)",
  background: "var(--bg-base)",
  fontSize: 11,
} as const;

const thGroup: CSSProperties = {
  background: BB_GRID_HEADER_BG,
  color: "var(--text-primary)",
  fontSize: BB_GRID_HEADER_FONT_SIZE,
  fontWeight: BB_GRID_HEADER_FONT_WEIGHT,
  letterSpacing: BB_GRID_HEADER_LETTER_SPACING,
  textTransform: "uppercase",
  fontFamily: BB_GRID_FONT_STACK,
  textAlign: "center",
  cursor: "pointer",
  userSelect: "none",
};

const thSub: CSSProperties = {
  background: BB_GRID_HEADER_BG,
  color: MUTED,
  fontSize: BB_GRID_HEADER_FONT_SIZE,
  fontWeight: 500,
  fontFamily: BB_GRID_FONT_STACK,
  textAlign: "center",
  textTransform: "none",
  letterSpacing: "0.02em",
  cursor: "pointer",
  userSelect: "none",
};

const thVolSub: CSSProperties = {
  ...thSub,
  color: VOL_HEADER,
};

const tdNum: CSSProperties = {
  fontFamily: BB_GRID_FONT_STACK,
  textAlign: "right",
};

type SortKey =
  | "ticker"
  | "price"
  | "weight"
  | "market_value"
  | "vol21_ann"
  | "vol21_dly"
  | "vol21_dly_sh"
  | "vol21_port_dollar"
  | "vol63_ann"
  | "vol63_dly"
  | "vol63_dly_sh"
  | "vol63_port_dollar"
  | "vol126_ann"
  | "vol126_dly"
  | "vol126_dly_sh"
  | "vol126_port_dollar"
  | "sharpe21"
  | "sharpe63"
  | "sharpe126"
  | "var95_dollar"
  | "var95_pct"
  | "cvar95_dollar"
  | "cvar95_pct";

function sortValue(row: PositionRisk, key: SortKey): number | string {
  switch (key) {
    case "ticker":
      return row.ticker;
    case "price":
      return row.lastPrice;
    case "weight":
      return row.weight;
    case "market_value":
      return row.marketValue;
    case "vol21_ann":
      return row.vol21d;
    case "vol21_dly":
      return annualToDailyVol(row.vol21d);
    case "vol21_dly_sh":
      return row.lastPrice * annualToDailyVol(row.vol21d);
    case "vol21_port_dollar":
      return row.marketValue * annualToDailyVol(row.vol21d);
    case "vol63_ann":
      return row.vol63d;
    case "vol63_dly":
      return annualToDailyVol(row.vol63d);
    case "vol63_dly_sh":
      return row.lastPrice * annualToDailyVol(row.vol63d);
    case "vol63_port_dollar":
      return row.marketValue * annualToDailyVol(row.vol63d);
    case "vol126_ann":
      return row.vol126d;
    case "vol126_dly":
      return annualToDailyVol(row.vol126d);
    case "vol126_dly_sh":
      return row.lastPrice * annualToDailyVol(row.vol126d);
    case "vol126_port_dollar":
      return row.marketValue * annualToDailyVol(row.vol126d);
    case "sharpe21":
      return row.sharpe21d;
    case "sharpe63":
      return row.sharpe63d;
    case "sharpe126":
      return row.sharpe126d;
    case "var95_dollar":
      return row.varDollar95;
    case "var95_pct":
      return row.marketValue > 0 ? row.varDollar95 / row.marketValue : 0;
    case "cvar95_dollar":
      return row.cvar95;
    case "cvar95_pct":
      return row.marketValue > 0 ? row.cvar95 / row.marketValue : 0;
  }
}

function fmtSharePrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return "—";
  return fmtPrice(price);
}

function fmtSharpe(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

function sharpeColor(n: number): string | undefined {
  if (!Number.isFinite(n) || n === 0) return undefined;
  return n > 0 ? POSITIVE : NEGATIVE;
}

function sparkPositive(data: number[]) {
  if (data.length < 2) return undefined;
  return data[data.length - 1]! >= data[0]!;
}

function volCells(
  row: PositionRisk,
  annualVol: number,
  isFooter: boolean,
) {
  const dailyVol = annualToDailyVol(annualVol);
  const footerBg = isFooter ? { background: "rgba(240,182,93,0.10)" } : undefined;
  const cellStyle = { ...tdNum, color: "#fff", ...footerBg };
  const volHeat = heatVolClassification(annualVol);
  const volPctStyle = { ...tdNum, color: "#fff", background: volHeat };
  return (
    <>
      <td className="bb-num" style={volPctStyle}>
        {fmtBbVolPct1d(annualVol)}
      </td>
      <td className="bb-num" style={volPctStyle}>
        {fmtBbVolPct1d(dailyVol)}
      </td>
      <td className="bb-num" style={cellStyle}>
        {fmtBbShareVolDollar(row.lastPrice, dailyVol)}
      </td>
      <td className="bb-num" style={cellStyle}>
        {fmtBbWholeDollar(row.marketValue * dailyVol)}
      </td>
    </>
  );
}

function volSparkCell(data: number[], groupEnd: boolean, isFooter: boolean) {
  const footerBg = isFooter ? { background: "rgba(240,182,93,0.10)" } : undefined;
  return (
    <td
      className={`bb-risk-spark-col${groupEnd ? " bb-col-group-end" : ""}`}
      style={{ textAlign: "center", ...footerBg }}
    >
      <Sparkline
        data={data}
        positive={sparkPositive(data)}
        height={18}
        width={52}
      />
    </td>
  );
}

function sharpeCells(
  value: number,
  spark: number[],
  groupEnd: boolean,
  isFooter: boolean,
) {
  const footerBg = isFooter ? { background: "rgba(240,182,93,0.10)" } : undefined;
  return (
    <>
      <td
        className="bb-num"
        style={{ ...tdNum, color: sharpeColor(value), ...footerBg }}
      >
        {fmtSharpe(value)}
      </td>
      <td
        className={`bb-risk-spark-col${groupEnd ? " bb-col-group-end" : ""}`}
        style={{ textAlign: "center", ...footerBg }}
      >
        <Sparkline
          data={spark}
          positive={sparkPositive(spark)}
          height={18}
          width={52}
        />
      </td>
    </>
  );
}

function riskCells(
  dollars: number,
  notional: number,
  groupEnd: boolean,
  isFooter: boolean,
) {
  const footerBg = isFooter ? { background: "rgba(240,182,93,0.10)" } : undefined;
  const endCls = groupEnd ? " bb-col-group-end" : "";
  return (
    <>
      <td className="bb-num" style={{ ...tdNum, color: CYAN, ...footerBg }}>
        {fmtBbWholeDollar(dollars)}
      </td>
      <td className={`bb-num${endCls}`} style={{ ...tdNum, color: MUTED, ...footerBg }}>
        {fmtBbLossPct(dollars, notional)}
      </td>
    </>
  );
}

const CSV_HEADERS = [
  "Ticker",
  "Price",
  "Weight%",
  "Tot$",
  "Vol1mo_Ann%",
  "Vol1mo_Dly%",
  "Vol1mo_Dly_$/sh",
  "Vol1mo_Dly_Port$",
  "Vol3mo_Ann%",
  "Vol3mo_Dly%",
  "Vol3mo_Dly_$/sh",
  "Vol3mo_Dly_Port$",
  "Vol6mo_Ann%",
  "Vol6mo_Dly%",
  "Vol6mo_Dly_$/sh",
  "Vol6mo_Dly_Port$",
  "Sharpe1mo",
  "Sharpe3mo",
  "Sharpe6mo",
  "VaR95_$",
  "VaR95_DlyPct",
  "CVaR95_$",
  "CVaR95_DlyPct",
];

function volCsvFields(row: PositionRisk, annualVol: number) {
  const dailyVol = annualToDailyVol(annualVol);
  return [
    fmtBbVolPct1d(annualVol),
    fmtBbVolPct1d(dailyVol),
    fmtBbShareVolDollar(row.lastPrice, dailyVol),
    fmtBbWholeDollar(row.marketValue * dailyVol),
  ];
}

function rowToCsv(row: PositionRisk): string {
  const vals = [
    row.ticker,
    fmtSharePrice(row.lastPrice),
    fmtWeightPct(row.weight),
    fmtBbWholeDollar(row.marketValue),
    ...volCsvFields(row, row.vol21d),
    ...volCsvFields(row, row.vol63d),
    ...volCsvFields(row, row.vol126d),
    fmtSharpe(row.sharpe21d),
    fmtSharpe(row.sharpe63d),
    fmtSharpe(row.sharpe126d),
    fmtBbWholeDollar(row.varDollar95),
    fmtBbLossPct(row.varDollar95, row.marketValue),
    fmtBbWholeDollar(row.cvar95),
    fmtBbLossPct(row.cvar95, row.marketValue),
  ];
  return vals.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
}

function exportCsv(rows: PositionRisk[], filename: string) {
  const body = rows.map(rowToCsv).join("\n");
  const blob = new Blob([CSV_HEADERS.join(",") + "\n" + body], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface RiskSummaryGridProps {
  rows: PositionRisk[];
  footerRow?: PositionRisk;
  searchFields: (row: PositionRisk) => string;
  dailyPnlByTicker?: Map<string, number>;
  pageSize?: number;
  exportFilename?: string;
}

export function RiskSummaryGrid({
  rows,
  footerRow,
  searchFields,
  dailyPnlByTicker,
  pageSize = 50,
  exportFilename = "holdings-risk.csv",
}: RiskSummaryGridProps) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter((r) => searchFields(r).toLowerCase().includes(q));
  }, [rows, search, searchFields]);

  const sorted = useMemo(() => {
    if (sortKey) {
      return [...filtered].sort((a, b) => {
        const av = sortValue(a, sortKey);
        const bv = sortValue(b, sortKey);
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return sortDir === "asc" ? cmp : -cmp;
      });
    }
    if (dailyPnlByTicker) {
      return sortByAbsDollarDesc(
        filtered,
        (r) => dailyPnlByTicker.get(r.ticker) ?? 0,
      );
    }
    return filtered;
  }, [filtered, sortKey, sortDir, dailyPnlByTicker]);

  const paged = useMemo(
    () => sorted.slice(page * pageSize, (page + 1) * pageSize),
    [sorted, page, pageSize],
  );
  const totalPages = Math.ceil(sorted.length / pageSize);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(0);
  };

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (
      <span style={{ marginLeft: 3, fontSize: 9 }}>
        {sortDir === "asc" ? "▲" : "▼"}
      </span>
    ) : null;

  const renderVolSubHeaders = (prefix: "21" | "63" | "126") => {
    const ann = `vol${prefix}_ann` as SortKey;
    const dly = `vol${prefix}_dly` as SortKey;
    const sh = `vol${prefix}_dly_sh` as SortKey;
    const port = `vol${prefix}_port_dollar` as SortKey;
    return (
      <>
        <th style={thVolSub} onClick={() => handleSort(ann)}>
          Ann{sortArrow(ann)}
        </th>
        <th style={thVolSub} onClick={() => handleSort(dly)}>
          Dly{sortArrow(dly)}
        </th>
        <th style={thVolSub} onClick={() => handleSort(sh)}>
          Dly - $/sh{sortArrow(sh)}
        </th>
        <th style={thVolSub} onClick={() => handleSort(port)}>
          Dly - Port ${sortArrow(port)}
        </th>
        <th
          style={{ ...thVolSub, cursor: "default" }}
          className="bb-col-group-end bb-risk-spark-col"
        />
      </>
    );
  };

  const renderRow = (row: PositionRisk, isFooter: boolean) => (
    <tr
      key={isFooter ? `footer-${row.ticker}` : row.ticker}
      className={isFooter ? "bb-risk-footer" : undefined}
    >
      <td
        style={{
          color: ACCENT,
          fontWeight: isFooter ? 700 : 500,
          fontFamily: BB_GRID_FONT_STACK,
          whiteSpace: "nowrap",
          background: isFooter ? "rgba(240,182,93,0.10)" : undefined,
        }}
      >
        {row.ticker === "TOTAL" ? "Total" : row.ticker}
      </td>
      <td
        className="bb-num"
        style={{
          ...tdNum,
          color: "#fff",
          background: isFooter ? "rgba(240,182,93,0.10)" : undefined,
        }}
      >
        {isFooter ? "—" : fmtSharePrice(row.lastPrice)}
      </td>
      <td
        className="bb-weight-bar-cell"
        style={{
          ...tdNum,
          padding: 0,
          overflow: "hidden",
          background: isFooter ? "rgba(240,182,93,0.10)" : undefined,
        }}
      >
        <WeightDataBarCell weight={row.weight} showBar={!isFooter} />
      </td>
      <td
        className="bb-num bb-col-group-end"
        style={{
          ...tdNum,
          color: "#fff",
          background: isFooter ? "rgba(240,182,93,0.10)" : undefined,
        }}
      >
        {fmtBbWholeDollar(row.marketValue)}
      </td>
      {volCells(row, row.vol21d, isFooter)}
      {volSparkCell(row.vol21Spark, true, isFooter)}
      {volCells(row, row.vol63d, isFooter)}
      {volSparkCell(row.vol63Spark, true, isFooter)}
      {volCells(row, row.vol126d, isFooter)}
      {volSparkCell(row.vol126Spark, true, isFooter)}
      {sharpeCells(row.sharpe21d, row.sharpe21Spark, true, isFooter)}
      {sharpeCells(row.sharpe63d, row.sharpe63Spark, true, isFooter)}
      {sharpeCells(row.sharpe126d, row.sharpe126Spark, true, isFooter)}
      {riskCells(row.varDollar95, row.marketValue, true, isFooter)}
      {riskCells(row.cvar95, row.marketValue, true, isFooter)}
    </tr>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder="Search…"
          style={{
            flex: 1,
            padding: "0 6px",
            height: 18,
            borderRadius: 0,
            border: "1px solid var(--bg-border)",
            background: "var(--bg-elevated)",
            color: "var(--text-primary)",
            fontSize: 12,
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={() =>
            exportCsv(footerRow ? [...sorted, footerRow] : sorted, exportFilename)
          }
          style={{ ...btnFlat, color: "var(--text-secondary)", cursor: "pointer" }}
        >
          ↓ CSV
        </button>
      </div>

      <div
        style={{
          overflowX: "auto",
          borderRadius: 0,
          border: "1px solid var(--bg-border)",
        }}
      >
        <table className="bb-risk-grid">
          <thead>
            <tr>
              <th
                rowSpan={2}
                style={{ ...thGroup, textAlign: "left" }}
                onClick={() => handleSort("ticker")}
              >
                Ticker
                {sortArrow("ticker")}
              </th>
              <th
                rowSpan={2}
                style={{ ...thGroup, textAlign: "right" }}
                onClick={() => handleSort("price")}
              >
                Price
                {sortArrow("price")}
              </th>
              <th
                rowSpan={2}
                style={{ ...thGroup, textAlign: "right" }}
                onClick={() => handleSort("weight")}
              >
                % Wgt
                {sortArrow("weight")}
              </th>
              <th
                rowSpan={2}
                className="bb-col-group-end"
                style={{ ...thGroup, textAlign: "right" }}
                onClick={() => handleSort("market_value")}
              >
                Tot $
                {sortArrow("market_value")}
              </th>
              <th colSpan={5} style={thGroup}>
                Vol 1mo
              </th>
              <th colSpan={5} style={thGroup}>
                Vol 3mo
              </th>
              <th colSpan={5} style={thGroup}>
                Vol 6mo
              </th>
              <th colSpan={2} style={thGroup}>
                Sharpe 1mo
              </th>
              <th colSpan={2} style={thGroup}>
                Sharpe 3mo
              </th>
              <th colSpan={2} style={thGroup}>
                Sharpe 6mo
              </th>
              <th colSpan={2} style={thGroup}>
                VaR 95%
              </th>
              <th colSpan={2} style={thGroup} className="bb-col-group-end">
                CVaR 95%
              </th>
            </tr>
            <tr>
              {renderVolSubHeaders("21")}
              {renderVolSubHeaders("63")}
              {renderVolSubHeaders("126")}
              <th style={thSub} onClick={() => handleSort("sharpe21")}>
                SR{sortArrow("sharpe21")}
              </th>
              <th style={{ ...thSub, cursor: "default" }} className="bb-col-group-end bb-risk-spark-col" />
              <th style={thSub} onClick={() => handleSort("sharpe63")}>
                SR{sortArrow("sharpe63")}
              </th>
              <th style={{ ...thSub, cursor: "default" }} className="bb-col-group-end bb-risk-spark-col" />
              <th style={thSub} onClick={() => handleSort("sharpe126")}>
                SR{sortArrow("sharpe126")}
              </th>
              <th style={{ ...thSub, cursor: "default" }} className="bb-col-group-end bb-risk-spark-col" />
              <th style={thSub} onClick={() => handleSort("var95_dollar")}>
                ${sortArrow("var95_dollar")}
              </th>
              <th style={thSub} onClick={() => handleSort("var95_pct")}>
                Dly%{sortArrow("var95_pct")}
              </th>
              <th style={thSub} onClick={() => handleSort("cvar95_dollar")}>
                ${sortArrow("cvar95_dollar")}
              </th>
              <th
                style={thSub}
                className="bb-col-group-end"
                onClick={() => handleSort("cvar95_pct")}
              >
                Dly%{sortArrow("cvar95_pct")}
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.map((row) => renderRow(row, false))}
            {footerRow && renderRow(footerRow, true)}
            {paged.length === 0 && !footerRow && (
              <tr>
                <td
                  colSpan={29}
                  style={{
                    padding: 24,
                    textAlign: "center",
                    color: "var(--text-muted)",
                  }}
                >
                  No data
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 6,
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {page * pageSize + 1}–{Math.min((page + 1) * pageSize, sorted.length)} of{" "}
            {sorted.length}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            style={{
              ...btnFlat,
              color: page === 0 ? "var(--text-muted)" : "var(--text-secondary)",
              cursor: page === 0 ? "not-allowed" : "pointer",
            }}
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            style={{
              ...btnFlat,
              color:
                page >= totalPages - 1 ? "var(--text-muted)" : "var(--text-secondary)",
              cursor: page >= totalPages - 1 ? "not-allowed" : "pointer",
            }}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}
