"use client";
/**
 * Right-rail analytics panels: STRIP BOARD (BAL/CAL/rolling strips with dated
 * Δ columns), CURVE STRUCTURE, and SEASONALITY (gas curves only). All read
 * the analytics DTO; heat cells ride heatSignedBloomberg.
 */
import { heatSignedBloomberg } from "@/domain/calculations/heatmap";
import { contractMonthLabel, shortDate } from "@/lib/commodities/format";
import type { CurveAnalyticsDto } from "@/types/commodities";
import { copyTsv } from "./clipboard";

function fmt(v: number | null, dp: number): string {
  return v === null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function sgn(v: number | null, dp: number): string {
  return v === null ? "—" : `${v > 0 ? "+" : ""}${fmt(v, dp)}`;
}

export function StripBoard({
  analytics,
  curveName,
  unit,
  decimals,
  onCopied,
}: {
  analytics: CurveAnalyticsDto;
  curveName: string;
  unit: string;
  decimals: number;
  onCopied: (msg: string) => void;
}) {
  const rows = analytics.stripBoard;
  const deltaIds = rows[0]?.deltas.map((d) => d.vintageId) ?? [];
  const maxAbs = Math.max(0.0001, ...rows.flatMap((r) => r.deltas.map((d) => Math.abs(d.abs ?? 0))));

  const copy = async () => {
    const ok = await copyTsv(
      rows.map((r) => [r.label, fmt(r.price, decimals), ...r.deltas.map((d) => (d.abs === null ? "" : d.abs.toFixed(decimals)))]),
    );
    onCopied(ok ? "COPIED — PASTE INTO EXCEL" : "COPY BLOCKED");
  };

  return (
    <div className="cmdx-panel">
      <div className="cmdx-phead">
        <span className="t">STRIP BOARD</span>
        <span className="sub">
          {curveName} · {unit}
        </span>
        <div className="right">
          <button className="cmdx-btn-ghost" onClick={copy}>
            ⧉
          </button>
        </div>
      </div>
      <div className="cmdx-pbody">
        <table className="cmdx-table">
          <thead>
            <tr>
              <th>STRIP</th>
              <th>PX</th>
              {rows[0]?.deltas.map((d) => (
                <th key={d.vintageId}>
                  Δ{d.vintageId}
                  <span className="thd">{d.resolvedDate ? shortDate(d.resolvedDate) : "—"}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="rowlbl">{r.label}</td>
                <td style={{ color: "#ffd84d" }}>{fmt(r.price, decimals)}</td>
                {deltaIds.map((id) => {
                  const d = r.deltas.find((x) => x.vintageId === id)!;
                  return (
                    <td key={id} style={{ background: d.abs === null ? undefined : heatSignedBloomberg(d.abs, maxAbs), color: "#fff" }}>
                      {sgn(d.abs, decimals)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CurveStructurePanel({
  analytics,
  unit,
  decimals,
}: {
  analytics: CurveAnalyticsDto;
  unit: string;
  decimals: number;
}) {
  const s = analytics.structure;
  const pos = (v: number | null) => (v !== null && v >= 0 ? "text-pos" : "text-neg");
  const m0 = s.promptMonth ? contractMonthLabel(s.promptMonth) : "—";
  return (
    <div className="cmdx-panel">
      <div className="cmdx-phead">
        <span className="t">CURVE STRUCTURE</span>
      </div>
      <div className="cmdx-pbody">
        <table className="cmdx-table">
          <tbody>
            <tr>
              <td className="rowlbl">SHAPE (1M→1Y)</td>
              <td className={s.backwardated === null ? undefined : s.backwardated ? "text-pos" : "text-neg"} style={{ fontWeight: 600 }}>
                {s.backwardated === null ? "—" : s.backwardated ? "BACKWARDATED" : "CONTANGO"}
              </td>
            </tr>
            <tr>
              <td className="rowlbl">PROMPT {m0}</td>
              <td>
                {fmt(s.prompt, decimals)} {unit}
              </td>
            </tr>
            <tr>
              <td className="rowlbl">PROMPT − 2ND</td>
              <td className={pos(s.promptMinus2nd)}>{sgn(s.promptMinus2nd, decimals)}</td>
            </tr>
            <tr>
              <td className="rowlbl">PROMPT − 12TH</td>
              <td className={pos(s.promptMinus12th)}>{sgn(s.promptMinus12th, decimals)}</td>
            </tr>
            <tr>
              <td className="rowlbl">1Y ROLL YIELD</td>
              <td className={pos(s.rollYield1YPct)}>{s.rollYield1YPct === null ? "—" : `${sgn(s.rollYield1YPct, 1)}%`}</td>
            </tr>
            <tr>
              <td className="rowlbl">PROMPT Δ vs 1Y{s.vintage1YDate ? ` (${shortDate(s.vintage1YDate)})` : ""}</td>
              <td className={pos(s.promptDeltaVs1Y)}>{sgn(s.promptDeltaVs1Y, decimals)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SeasonalityPanel({
  analytics,
  unit,
  decimals,
}: {
  analytics: CurveAnalyticsDto;
  unit: string;
  decimals: number;
}) {
  const s = analytics.seasonality;
  if (!s) return null;
  const oneMDate = analytics.deltaGrid.find((r) => r.vintageId === "1M")?.resolvedDate ?? null;
  return (
    <div className="cmdx-panel">
      <div className="cmdx-phead">
        <span className="t">SEASONALITY</span>
        <span className="sub">gas strips</span>
      </div>
      <div className="cmdx-pbody">
        <table className="cmdx-table">
          <thead>
            <tr>
              <th>STRIP</th>
              <th>PX</th>
              <th>
                Δ1M<span className="thd">{oneMDate ? shortDate(oneMDate) : "—"}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r) => (
              <tr key={r.label}>
                <td className="rowlbl">{r.label}</td>
                <td style={{ color: "#ffd84d" }}>{fmt(r.price, decimals)}</td>
                <td className={r.delta1M !== null && r.delta1M >= 0 ? "text-pos" : "text-neg"}>{sgn(r.delta1M, decimals)}</td>
              </tr>
            ))}
            <tr>
              <td className="rowlbl">W/S SPREAD</td>
              <td className="text-cyan" colSpan={2}>
                {sgn(s.winterSummerSpread, decimals)} {unit}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
