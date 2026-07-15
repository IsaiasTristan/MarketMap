"use client";
/**
 * PINNED CURVES: small multiples — latest strip (deep amber) vs the 1M-ago
 * vintage (pale ghost), front value, Δ1W front. Click focuses the curve in
 * the main chart. One vintages fetch per pinned curve (5-min react-query
 * cache keeps this cheap).
 */
import { shortDate } from "@/lib/commodities/format";
import type { CurveInfoDto } from "@/types/commodities";
import { STRIP_DISPLAY_MONTHS, VINTAGE_RAMP } from "./chartModel";
import { useCurveVintages } from "./useCommodities";

const W = 215;
const H = 64;

function fmt(v: number | null, dp: number): string {
  return v === null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function SmallMultiple({
  curve,
  basisMode,
  focused,
  onFocus,
}: {
  curve: CurveInfoDto;
  basisMode: "DIFF" | "OUT";
  focused: boolean;
  onFocus: () => void;
}) {
  const q = useCurveVintages(curve.code, ["1W", "1M"], basisMode, 0);
  const dto = q.data ?? null;

  const latest = dto?.latest.slice(0, STRIP_DISPLAY_MONTHS) ?? [];
  const oneM = dto?.vintages.find((v) => v.id === "1M")?.points ?? [];
  const oneW = dto?.vintages.find((v) => v.id === "1W")?.points ?? [];
  const byMonth1M = new Map(oneM.map((p) => [p.contractMonth, p.price]));
  const ghost = latest.map((p) => byMonth1M.get(p.contractMonth) ?? null);

  const vals = [...latest.map((p) => p.price), ...ghost.filter((v): v is number => v !== null)];
  let lo = vals.length ? Math.min(...vals) : 0;
  let hi = vals.length ? Math.max(...vals) : 1;
  const pad = (hi - lo) * 0.1 || 1;
  lo -= pad;
  hi += pad;
  const X = (i: number) => 4 + (latest.length > 1 ? (i / (latest.length - 1)) * (W - 8) : 0);
  const Y = (v: number) => 4 + ((hi - v) / (hi - lo)) * (H - 8);
  const path = (arr: (number | null)[]) => {
    let d = "";
    let pen = false;
    arr.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const front = latest[0]?.price ?? null;
  const front1W = oneW.find((p) => p.contractMonth === latest[0]?.contractMonth)?.price ?? oneW[0]?.price ?? null;
  const d1w = front !== null && front1W !== null ? front - front1W : null;

  return (
    <div className={`cmdx-smcard${focused ? " focused" : ""}`} onClick={onFocus}>
      <div className="cmdx-smhead">
        <span className={`cmdx-grp ${curve.group}`}>{curve.group}</span>
        <span className="nm">
          {curve.name}
          {curve.kind === "BASIS" && basisMode === "DIFF" ? " (BASIS)" : ""}
        </span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
        {lo < 0 && hi > 0 && <line x1={4} x2={W - 4} y1={Y(0)} y2={Y(0)} stroke="#2a2a2a" strokeDasharray="2 3" />}
        <path d={path(ghost)} fill="none" stroke={VINTAGE_RAMP["1M"].color} strokeWidth={1} opacity={0.5} />
        <path d={path(latest.map((p) => p.price))} fill="none" stroke={VINTAGE_RAMP.LATEST.color} strokeWidth={1.8} />
      </svg>
      <div className="cmdx-smfoot">
        <span style={{ color: "#ffd84d" }}>{fmt(front, curve.decimals)}</span>
        <span style={{ color: "var(--text-secondary)" }}>{curve.unit}</span>
        <span className={d1w !== null && d1w >= 0 ? "text-pos" : "text-neg"} style={{ marginLeft: "auto" }}>
          Δ1W {d1w === null ? "—" : `${d1w > 0 ? "+" : ""}${fmt(d1w, curve.decimals)}`}
        </span>
      </div>
    </div>
  );
}

export function PinnedMultiples({
  curves,
  basisMode,
  focusCode,
  onFocus,
  latestSettleDate,
  oneMonthDate,
}: {
  curves: CurveInfoDto[];
  basisMode: "DIFF" | "OUT";
  focusCode: string | null;
  onFocus: (code: string) => void;
  latestSettleDate: string | null;
  oneMonthDate: string | null;
}) {
  if (curves.length === 0) return null;
  return (
    <>
      <div className="cmdx-phead" style={{ border: "1px solid var(--bg-border)", margin: "0 12px" }}>
        <span className="t">PINNED CURVES</span>
        <span className="sub">
          latest{latestSettleDate ? ` ${shortDate(latestSettleDate)}` : ""} (deep amber) vs 1M-ago
          {oneMonthDate ? ` ${shortDate(oneMonthDate)}` : ""} (pale ghost) · front value · Δ1W front
        </span>
      </div>
      <div className="cmdx-smgrid">
        {curves.map((c) => (
          <SmallMultiple key={c.code} curve={c} basisMode={basisMode} focused={c.code === focusCode} onFocus={() => onFocus(c.code)} />
        ))}
      </div>
    </>
  );
}
