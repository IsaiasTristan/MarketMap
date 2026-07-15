"use client";
/**
 * STRIP CHANGE: latest settle minus each prior vintage, one row per vintage
 * (left border in the vintage's ramp color, exact resolved date), columns =
 * the tenor grid with contract-month sublabels + 12/36/60M strip averages.
 * Each cell shows Δ$ over Δ%, heat-colored on the grid-wide |Δ$| span.
 */
import { heatSignedBloomberg } from "@/domain/calculations/heatmap";
import { contractMonthLabel, shortDate } from "@/lib/commodities/format";
import type { CurveAnalyticsDto } from "@/types/commodities";
import { VINTAGE_RAMP } from "./chartModel";
import { copyTsv } from "./clipboard";

export function StripChangeTable({
  analytics,
  curveName,
  decimals,
  onCopied,
}: {
  analytics: CurveAnalyticsDto;
  curveName: string;
  decimals: number;
  onCopied: (msg: string) => void;
}) {
  const { deltaGrid, tenorColumns, latestSettleDate } = analytics;
  const maxAbs = Math.max(0.0001, ...deltaGrid.flatMap((r) => r.cells.map((c) => Math.abs(c.abs ?? 0))));

  const sgn = (v: number | null, dp: number) =>
    v === null ? "—" : `${v > 0 ? "+" : ""}${v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

  const copy = async () => {
    const rows: (string | null)[][] = [
      [
        `LATEST ${shortDate(latestSettleDate)} vs`,
        ...tenorColumns.map((c) => (c.contractMonth ? `${c.label} ${contractMonthLabel(c.contractMonth)}` : c.label)),
      ],
      ...deltaGrid.map((r) => [
        `${r.vintageId} ${shortDate(r.resolvedDate)}`,
        ...r.cells.map((c) => (c.abs === null ? "" : c.abs.toFixed(decimals))),
      ]),
    ];
    const ok = await copyTsv(rows);
    onCopied(ok ? "COPIED — PASTE INTO EXCEL" : "COPY BLOCKED");
  };

  return (
    <div className="cmdx-panel">
      <div className="cmdx-phead">
        <span className="t">STRIP CHANGE</span>
        <span className="sub">
          {curveName} · LATEST ({shortDate(latestSettleDate)}) minus each prior settle-date curve · Δ$ over Δ% · tenor = contract month
        </span>
        <div className="right">
          <button className="cmdx-btn-ghost" onClick={copy}>
            COPY TABLE ⧉
          </button>
        </div>
      </div>
      <div className="cmdx-pbody" style={{ overflowX: "auto" }}>
        <table className="cmdx-table">
          <thead>
            <tr>
              <th>vs CURVE AS OF</th>
              {tenorColumns.map((c) => (
                <th key={c.label}>
                  {c.label}
                  <span className="thd">{c.contractMonth ? contractMonthLabel(c.contractMonth) : "avg"}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {deltaGrid.map((r) => (
              <tr key={r.vintageId}>
                <td
                  className="rowlbl"
                  style={{ borderLeft: `3px solid ${VINTAGE_RAMP[r.vintageId]?.color ?? "#666"}`, paddingLeft: 8 }}
                >
                  {r.vintageId} · {shortDate(r.resolvedDate)}
                </td>
                {r.cells.map((c, k) => (
                  <td
                    key={k}
                    style={{ background: c.abs === null ? "#111" : heatSignedBloomberg(c.abs, maxAbs), color: "#fff" }}
                  >
                    {sgn(c.abs, decimals)}
                    <span className="d2">{c.pct === null ? "—" : `${sgn(c.pct, 1)}%`}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
