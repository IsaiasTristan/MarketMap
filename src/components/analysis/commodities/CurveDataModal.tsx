"use client";
/**
 * Curve-data modal: every point on the chart as a verifiable table — history
 * rows tagged H in slate, an amber separator at the settle seam, then one
 * column per toggled vintage. Selection stays in sync with the chart's drag
 * selection (rows highlight; row clicks extend/clear). COPY exports TSV with
 * a TYPE column (HIST|FUT). Portal + ESC/backdrop close per
 * StockPriceChartModal conventions.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { shortDate } from "@/lib/commodities/format";
import { HISTORY_COLOR, type ChartModel } from "./chartModel";
import { copyTsv } from "./clipboard";

function fmt(v: number, dp: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export interface CurveDataModalProps {
  open: boolean;
  onClose: () => void;
  model: ChartModel;
  curveName: string;
  unit: string;
  decimals: number;
  latestSettleDate: string;
  selection: [number, number] | null;
  onSelectionChange: (sel: [number, number] | null) => void;
  onCopied: (msg: string) => void;
}

export function CurveDataModal(props: CurveDataModalProps) {
  const { open, onClose, model, curveName, unit, decimals, latestSettleDate, selection, onSelectionChange, onCopied } = props;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted || !open) return null;

  const { histLen, total, labels, history, series } = model;

  const rowClick = (i: number) => {
    if (!selection) onSelectionChange([i, i]);
    else if (i < selection[0]) onSelectionChange([i, selection[1]]);
    else if (i > selection[1]) onSelectionChange([selection[0], i]);
    else onSelectionChange(null);
  };

  const doCopy = async () => {
    const a = selection ? selection[0] : 0;
    const b = selection ? selection[1] : total - 1;
    const rows: (string | number | null)[][] = [
      [
        "CONTRACT",
        "TYPE",
        ...(histLen > 0 ? [`REALIZED MO AVG (${unit})`] : []),
        ...series.map((s) => `${curveName} ${s.id} (${shortDate(s.resolvedDate)})`),
      ],
    ];
    for (let i = a; i <= b; i++) {
      const isH = i < histLen;
      rows.push([
        labels[i]!,
        isH ? "HIST" : "FUT",
        ...(histLen > 0 ? [isH ? history[i]!.price.toFixed(decimals) : ""] : []),
        ...series.map((s) => {
          if (isH) return "";
          const v = s.values[i - histLen];
          return v === null || v === undefined ? "" : v.toFixed(decimals);
        }),
      ]);
    }
    const ok = await copyTsv(rows);
    onCopied(ok ? `COPIED ${b - a + 1} ROWS (${a < histLen ? "HIST+FUT" : "FUT"})` : "COPY BLOCKED");
  };

  return createPortal(
    <div
      className="cmdx-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdx-modal">
        <div className="cmdx-phead">
          <span className="t">CURVE DATA</span>
          <span className="sub">
            {curveName} · {unit}
            {histLen > 0 ? " · HIST + FUT" : ""}
          </span>
          <div className="right">
            <button className="cmdx-btn-primary" style={{ padding: "2px 10px", fontSize: 10 }} onClick={doCopy}>
              COPY ⧉
            </button>
            <button className="cmdx-btn-ghost" onClick={onClose}>
              ✕ CLOSE
            </button>
          </div>
        </div>
        <div className="cmdx-datatbl">
          <table className="cmdx-table">
            <thead>
              <tr>
                <th>CONTRACT</th>
                {histLen > 0 && (
                  <th style={{ color: HISTORY_COLOR }}>
                    REALIZED<span className="thd">MO AVG</span>
                  </th>
                )}
                {series.map((s) => (
                  <th key={s.id} style={{ color: s.color }}>
                    {s.id}
                    <span className="thd">{shortDate(s.resolvedDate)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: total }, (_, i) => {
                const isH = i < histLen;
                const inSel = selection !== null && i >= selection[0] && i <= selection[1];
                return (
                  <FragmentRow
                    key={i}
                    showSeparator={histLen > 0 && i === histLen}
                    separatorColSpan={1 + (histLen > 0 ? 1 : 0) + series.length}
                    separatorLabel={`— ${shortDate(latestSettleDate)} SETTLE · FUTURES STRIP BELOW —`}
                  >
                    <tr className={inSel ? "selrow" : undefined} onClick={() => rowClick(i)} style={{ cursor: "pointer" }}>
                      <td className="rowlbl" style={isH ? { color: HISTORY_COLOR } : undefined}>
                        {labels[i]}
                        {isH && <span style={{ fontSize: 8.5, color: "#4a5a6a" }}> H</span>}
                      </td>
                      {histLen > 0 && (
                        <td style={{ color: HISTORY_COLOR }}>{isH ? fmt(history[i]!.price, decimals) : ""}</td>
                      )}
                      {series.map((s) => {
                        const v = isH ? null : s.values[i - histLen];
                        return <td key={s.id}>{v === null || v === undefined ? "" : fmt(v, decimals)}</td>;
                      })}
                    </tr>
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FragmentRow({
  showSeparator,
  separatorColSpan,
  separatorLabel,
  children,
}: {
  showSeparator: boolean;
  separatorColSpan: number;
  separatorLabel: string;
  children: React.ReactNode;
}) {
  return (
    <>
      {showSeparator && (
        <tr>
          <td
            colSpan={separatorColSpan}
            style={{ color: "#ffb700", background: "#140d00", textAlign: "center", fontSize: 9.5, letterSpacing: "0.05em" }}
          >
            {separatorLabel}
          </td>
        </tr>
      )}
      {children}
    </>
  );
}
