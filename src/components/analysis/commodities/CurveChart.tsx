"use client";
/**
 * Main forward-curve chart: latest strip + toggled vintages on the amber
 * ramp, realized history as a slate line over a shaded region with the amber
 * dashed settle divider, optional cyan dashed deck overlay, and drag-to-select
 * months across the combined hist+fut domain. Hand-rolled SVG port of the
 * mockup renderer (docs/mockups/commodities-dashboard-mockup-v4.html).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { shortDate } from "@/lib/commodities/format";
import { DECK_COLOR, HISTORY_COLOR, HISTORY_REGION_FILL, type ChartModel } from "./chartModel";

const H = 400;
const M_LEFT = 52;
const M_RIGHT = 12;
const M_TOP = 14;
const M_BOTTOM = 26;

function fmt(v: number, dp: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export interface CurveChartProps {
  model: ChartModel;
  decimals: number;
  latestSettleDate: string;
  deck: { name: string; values: (number | null)[] } | null;
  selection: [number, number] | null;
  onSelectionChange: (sel: [number, number] | null) => void;
}

export function CurveChart({
  model,
  decimals,
  latestSettleDate,
  deck,
  selection,
  onSelectionChange,
}: CurveChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(820);
  const dragStart = useRef<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 820));
    ro.observe(el);
    setWidth(el.clientWidth || 820);
    return () => ro.disconnect();
  }, []);

  const { histLen, total, labels, history, series } = model;
  const iw = width - M_LEFT - M_RIGHT;
  const ih = H - M_TOP - M_BOTTOM;

  // Y domain across everything drawn.
  const all: number[] = [...history.map((h) => h.price)];
  for (const s of series) for (const v of s.values) if (v !== null) all.push(v);
  if (deck) for (const v of deck.values) if (v !== null) all.push(v);
  let lo = all.length ? Math.min(...all) : 0;
  let hi = all.length ? Math.max(...all) : 1;
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad;
  hi += pad;

  const X = useCallback(
    (i: number) => M_LEFT + (total > 1 ? (i / (total - 1)) * iw : 0),
    [total, iw],
  );
  const Y = useCallback((v: number) => M_TOP + ((hi - v) / (hi - lo)) * ih, [hi, lo, ih]);

  const idxFromEvent = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * width;
      return Math.max(0, Math.min(total - 1, Math.round(((x - M_LEFT) / iw) * (total - 1))));
    },
    [width, total, iw],
  );

  const path = (values: (number | null)[], offset: number): string => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${X(i + offset).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  // History↔futures boundary sits between the last hist and first fut point.
  const xb = histLen > 0 ? (X(histLen - 1) + X(histLen)) / 2 : null;
  const labelStep = total > 72 ? 9 : 6;
  const yTicks = [0, 1, 2, 3, 4, 5].map((k) => lo + ((hi - lo) * k) / 5);

  return (
    <div ref={wrapRef} className="cmdx-chartwrap">
      <svg
        className="cmdx-chart"
        viewBox={`0 0 ${width} ${H}`}
        onMouseDown={(e) => {
          const i = idxFromEvent(e);
          dragStart.current = i;
          onSelectionChange([i, i]);
        }}
        onMouseMove={(e) => {
          if (dragStart.current === null) return;
          const i = idxFromEvent(e);
          onSelectionChange([Math.min(dragStart.current, i), Math.max(dragStart.current, i)]);
        }}
        onMouseUp={() => {
          if (dragStart.current !== null && selection && selection[0] === selection[1]) {
            onSelectionChange(null); // click without drag clears
          }
          dragStart.current = null;
        }}
        onMouseLeave={() => {
          dragStart.current = null;
        }}
      >
        {histLen > 0 && xb !== null && (
          <rect x={M_LEFT} y={M_TOP} width={xb - M_LEFT} height={ih} fill={HISTORY_REGION_FILL} />
        )}
        {yTicks.map((v, k) => (
          <g key={k}>
            <line x1={M_LEFT} x2={width - M_RIGHT} y1={Y(v)} y2={Y(v)} stroke="#141414" />
            <text
              x={M_LEFT - 6}
              y={Y(v) + 3}
              textAnchor="end"
              fill="#6a6a6a"
              fontSize="9.5"
              fontFamily="var(--font-mono)"
            >
              {fmt(v, decimals)}
            </text>
          </g>
        ))}
        {labels.map((lbl, i) =>
          i % labelStep === 0 ? (
            <g key={i}>
              <line x1={X(i)} x2={X(i)} y1={M_TOP} y2={H - M_BOTTOM} stroke="#141414" />
              <text
                x={X(i)}
                y={H - 8}
                textAnchor="middle"
                fill="#6a6a6a"
                fontSize="9.5"
                fontFamily="var(--font-mono)"
              >
                {lbl}
              </text>
            </g>
          ) : null,
        )}
        {selection && selection[1] > selection[0] && (
          <g>
            <rect
              x={X(selection[0])}
              y={M_TOP}
              width={X(selection[1]) - X(selection[0])}
              height={ih}
              fill="#ffb700"
              opacity={0.1}
            />
            <line x1={X(selection[0])} x2={X(selection[0])} y1={M_TOP} y2={H - M_BOTTOM} stroke="#ffb700" strokeDasharray="3 3" />
            <line x1={X(selection[1])} x2={X(selection[1])} y1={M_TOP} y2={H - M_BOTTOM} stroke="#ffb700" strokeDasharray="3 3" />
          </g>
        )}
        {lo < 0 && hi > 0 && (
          <line x1={M_LEFT} x2={width - M_RIGHT} y1={Y(0)} y2={Y(0)} stroke="#3a3a3a" strokeDasharray="2 3" />
        )}
        {histLen > 0 && xb !== null && (
          <g>
            <path
              d={path(history.map((h) => h.price), 0)}
              fill="none"
              stroke={HISTORY_COLOR}
              strokeWidth={1.7}
            />
            <line x1={xb} x2={xb} y1={M_TOP} y2={H - M_BOTTOM} stroke="#ffb700" strokeWidth={1} strokeDasharray="4 3" opacity={0.8} />
            <text x={xb - 6} y={M_TOP + 11} textAnchor="end" fill={HISTORY_COLOR} fontSize="9.5" fontFamily="var(--font-mono)">
              ◀ REALIZED (MONTHLY AVG)
            </text>
            <text x={xb + 6} y={M_TOP + 11} fill="#ffb700" fontSize="9.5" fontFamily="var(--font-mono)">
              STRIP AS OF {shortDate(latestSettleDate)} ▶
            </text>
          </g>
        )}
        {[...series].reverse().map((s) => (
          <path
            key={s.id}
            d={path(s.values, histLen)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.width}
            opacity={s.opacity}
          />
        ))}
        {deck && (
          <g>
            <path d={path(deck.values, histLen)} fill="none" stroke={DECK_COLOR} strokeWidth={1.2} strokeDasharray="5 4" opacity={0.85} />
            <text x={X(total - 1) - 4} y={M_TOP + 24} textAnchor="end" fill={DECK_COLOR} fontSize="9.5" fontFamily="var(--font-mono)">
              DECK
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
