"use client";
/**
 * Pair matrix — for one sector, a subsector × subsector grid of the selected
 * engine's breadth gap (row long − column short) on a fixed diverging scale. An
 * arrow marks cells whose ordered pair moved ≥ the 4-week arrow threshold.
 * Columns are compact 3-letter codes; every header and cell carries a real
 * popover (portal DefinitionTooltip) with its own arithmetic — no native
 * `title=` tooltips. Sector + signal engine are controlled by the parent.
 */
import { useMemo } from "react";
import type { PairMatrixPayload, PairGroupCell } from "@/server/services/pairs/pairs-read.service";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";
import { subsectorCodes, formatGapPp } from "@/lib/pairs/labels";
import { PairMetricTip } from "./PairMetricTip";

export type MatrixEngine = "E1" | "E2" | "E3";

const SCALE = 20; // pp at full colour (counts for E3)

function cellBg(gap: number, scale: number): string {
  const t = Math.max(-1, Math.min(1, gap / scale));
  if (t === 0) return "transparent";
  const a = 0.12 + 0.55 * Math.abs(t);
  return t > 0 ? `rgba(47,143,69,${a.toFixed(3)})` : `rgba(168,58,63,${a.toFixed(3)})`;
}

/** The engine's breadth for a group (null-safe). */
function breadthOf(g: PairGroupCell, engine: MatrixEngine): number | null {
  if (engine === "E1") return g.e1Breadth;
  if (engine === "E2") return g.e2Breadth;
  return g.e3NetBuyers; // E3 is a count
}

const ENGINE_META: Record<MatrixEngine, { metricId: "e1Gap" | "e2Gap" | "e3NetBuyerGap"; unit: string; scale: number; label: string }> = {
  E1: { metricId: "e1Gap", unit: "pp", scale: SCALE, label: "analyst-revision breadth" },
  E2: { metricId: "e2Gap", unit: "pp", scale: SCALE, label: "inflection breadth" },
  E3: { metricId: "e3NetBuyerGap", unit: "", scale: 6, label: "13F net fund buyers" },
};

/** Sectors with ≥2 subsectors this week, busiest first — the selectable set. */
export function pairMatrixSectors(data: PairMatrixPayload): string[] {
  const counts = new Map<string, number>();
  for (const g of data.groups) counts.set(g.sector, (counts.get(g.sector) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);
}

const fmt = (v: number | null, unit: string) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(0)}${unit}`);

export function PairMatrix({ data, sector, engine = "E1" }: { data: PairMatrixPayload; sector: string; engine?: MatrixEngine }) {
  const meta = ENGINE_META[engine];
  const subs = useMemo(
    () =>
      (sector === "__ALL__" ? [...data.groups] : data.groups.filter((g) => g.sector === sector)).sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
    [data.groups, sector],
  );
  const codes = useMemo(() => subsectorCodes(subs.map((s) => s.key)), [subs]);
  const changeByPair = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of data.pairs) if (p.e1Gap4wChange !== null) m.set(`${p.longKey}|${p.shortKey}`, p.e1Gap4wChange);
    return m;
  }, [data.pairs]);

  if (subs.length === 0) {
    return <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 12 }}>No sector has ≥2 subsectors this week.</div>;
  }

  const cols = `160px repeat(${subs.length}, minmax(30px, 1fr))`;

  return (
    <div style={{ height: "100%", overflow: "auto", border: "1px solid var(--chrome-border)" }}>
      <div style={{ display: "grid", gridTemplateColumns: cols, alignItems: "stretch", fontSize: 9.5 }}>
        {/* header row */}
        <div
          style={{
            position: "sticky",
            top: 0,
            left: 0,
            zIndex: 3,
            height: 20,
            display: "flex",
            alignItems: "center",
            padding: "0 6px",
            fontSize: 8.5,
            letterSpacing: 0.3,
            color: "var(--text-muted)",
            background: "var(--bg-surface)",
            whiteSpace: "nowrap",
          }}
        >
          LONG (row) ↓ · SHORT (col) →
        </div>
        {subs.map((c) => (
          <div
            key={c.key}
            style={{
              position: "sticky",
              top: 0,
              zIndex: 2,
              height: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-secondary)",
              fontWeight: 600,
              background: "var(--bg-surface)",
              borderBottom: "1px solid var(--chrome-border)",
            }}
          >
            <PairMetricTip
              id={engine === "E1" ? "e1Breadth" : engine === "E2" ? "e2Breadth" : "e3NetBuyerGap"}
              label={`${c.key} (short leg)`}
              arithmetic={`${c.nameCount} names · ${meta.label} ${fmt(breadthOf(c, engine), meta.unit)}`}
            >
              {codes.get(c.key) ?? c.key.slice(0, 3)}
            </PairMetricTip>
          </div>
        ))}
        {/* body rows */}
        {subs.map((rowG) => (
          <RowCells key={rowG.key} rowG={rowG} subs={subs} changeByPair={changeByPair} engine={engine} meta={meta} codes={codes} />
        ))}
      </div>
    </div>
  );
}

function RowCells({
  rowG,
  subs,
  changeByPair,
  engine,
  meta,
  codes,
}: {
  rowG: PairGroupCell;
  subs: PairGroupCell[];
  changeByPair: Map<string, number>;
  engine: MatrixEngine;
  meta: (typeof ENGINE_META)[MatrixEngine];
  codes: Map<string, string>;
}) {
  const rowB = breadthOf(rowG, engine);
  return (
    <>
      <div
        style={{
          position: "sticky",
          left: 0,
          zIndex: 1,
          height: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          padding: "0 6px",
          textAlign: "right",
          color: "var(--text-secondary)",
          fontWeight: 600,
          background: "var(--bg-surface)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        <PairMetricTip
          id={engine === "E1" ? "e1Breadth" : engine === "E2" ? "e2Breadth" : "e3NetBuyerGap"}
          label={`${rowG.key} (long leg)`}
          arithmetic={`${rowG.nameCount} names · ${meta.label} ${fmt(rowB, meta.unit)}`}
        >
          {rowG.key}
        </PairMetricTip>
      </div>
      {subs.map((colG) => {
        if (rowG.key === colG.key) {
          // Diagonal = the subsector's OWN breadth in accent orange — the
          // reference point that makes the off-diagonal gap cells readable.
          return (
            <div
              key={colG.key}
              style={{
                height: 20,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(255,140,26,0.10)",
                color: "var(--color-accent)",
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}
            >
              <PairMetricTip
                id={engine === "E1" ? "e1Breadth" : engine === "E2" ? "e2Breadth" : "e3NetBuyerGap"}
                label={`${rowG.key} — own ${meta.label}`}
                arithmetic={`${rowG.nameCount} names · ${meta.label} ${fmt(rowB, meta.unit)}${
                  engine === "E1" && rowG.ptUpPct !== null && rowG.ptDownPct !== null
                    ? ` · ${rowG.ptUpPct.toFixed(0)}% up / ${rowG.ptDownPct.toFixed(0)}% down`
                    : ""
                }`}
              >
                <span style={{ borderBottom: "none" }}>{fmt(rowB, "")}</span>
              </PairMetricTip>
            </div>
          );
        }
        const colB = breadthOf(colG, engine);
        const gap = (rowB ?? 0) - (colB ?? 0);
        const chg = changeByPair.get(`${rowG.key}|${colG.key}`) ?? changeByPair.get(`${colG.key}|${rowG.key}`) ?? null;
        const showArrow = chg !== null && Math.abs(chg) >= PAIR_THRESHOLDS.gapMoveArrowPp;
        return (
          <div
            key={colG.key}
            style={{
              height: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: cellBg(gap, meta.scale),
              color: "var(--text-primary)",
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            <PairMetricTip
              id={meta.metricId}
              label={`${codes.get(rowG.key) ?? rowG.key} ▸ ${codes.get(colG.key) ?? colG.key}`}
              arithmetic={`gap = ${fmt(rowB, "")} − ${fmt(colB, "")} = ${formatGapPp(gap)}${meta.unit}${chg !== null ? ` · Δ4w ${chg > 0 ? "+" : ""}${chg.toFixed(0)}pp` : ""}`}
            >
              <span style={{ borderBottom: "none" }}>
                {formatGapPp(gap)}
                {showArrow && <span style={{ color: "var(--color-accent)", marginLeft: 1 }}>{gap > 0 ? "▲" : "▼"}</span>}
              </span>
            </PairMetricTip>
          </div>
        );
      })}
    </>
  );
}
