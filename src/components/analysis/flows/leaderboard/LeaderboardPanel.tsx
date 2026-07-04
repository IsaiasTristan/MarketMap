"use client";
/**
 * Flow Leaderboard — ranked accumulation heatmap. The ROW ORDER IS THE RANKING:
 * the top row is the strongest multi-quarter accumulation story. Sorting is fixed
 * by score (no user re-sort — the ranking is the product). A search box
 * highlights/scrolls to any ticker, including gated-out names ("below threshold").
 *
 * Row anatomy: [chevron][rank][ticker + badges / reason][5 quarter heat cells with
 * a bps micro-strip beneath][ACC sparkline][PRICE][WHO][score]. The chevron expands
 * the fund ledger inline; the score bar and WHO chip expose their breakdowns on hover.
 */
import { useMemo, useRef, useState } from "react";
import type { GatedOutRow, HeatCell } from "@/domain/calculations/flow-leaderboard";
import type { EnrichedRow, LeaderboardResult } from "@/server/services/institutional/institutional-leaderboard.service";
import { pickTextColor } from "@/components/analysis/factors/shared/bloomberg-grid";
import { useFlows } from "../useFlows";
import { PanelState, Sparkline, quarterLabel } from "../flowsUi";
import { LedgerPanel } from "../LedgerPanel";
import { flowHeatColor, heatCellDisplay, FLOW_BLUE, FLOW_RED } from "./flowHeat";

const HEAT_SPAN = 25; // diverging fill saturates at |25| net funds (per spec)
const BPS_SPAN = 30; // bps micro-strip saturates at |30| bps
const fmt = (n: number | null, d = 1): string => (n == null ? "—" : n.toFixed(d));
/** Compact quarter label for the column header, e.g. "Q1'25". */
function qShort(period: string): string {
  const [y, m] = period.split("-");
  const q = { "03": "Q1", "06": "Q2", "09": "Q3", "12": "Q4" }[m ?? ""] ?? "";
  return `${q}'${(y ?? "").slice(2)}`;
}

export function LeaderboardPanel({ period, onSelectTicker }: { period: string | null; onSelectTicker: (t: string) => void }) {
  const { data, state, error } = useFlows<LeaderboardResult>(
    ["flows-leaderboard", period],
    `/api/analysis/flows/leaderboard${period ? `?period=${period}` : ""}`,
    period != null,
  );
  const [query, setQuery] = useState("");
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const q = query.trim().toUpperCase();

  // Canonical trailing-5 quarters for the board: the 5 latest distinct cell
  // periods across all rows. Every row aligns its cells to these columns so the
  // header labels are meaningful and short-history names show em-dash gaps.
  const canon = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const r of [...data.accumulation, ...data.distribution]) for (const c of r.cells) set.add(c.period);
    return [...set].sort().slice(-5);
  }, [data]);

  const gatedMatch = useMemo(() => {
    if (!data || !q) return null;
    const onBoards = new Set([...data.accumulation, ...data.distribution].map((r) => r.ticker));
    if (onBoards.has(q)) return null;
    return data.gatedOut.find((g) => g.ticker === q) ?? null;
  }, [data, q]);

  function scrollTo(ticker: string) {
    const el = rowRefs.current.get(ticker);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Search + legend */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ position: "relative" }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery("");
                  if (e.key === "Enter" && q) scrollTo(q);
                }}
                placeholder="Find ticker…"
                style={{ height: 24, width: 180, padding: "0 24px 0 8px", background: "var(--bg-elevated)", border: "1px solid var(--bg-border)", color: "var(--text-primary)", fontSize: 11, borderRadius: 0 }}
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} title="Clear" style={{ position: "absolute", right: 4, top: 3, width: 18, height: 18, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>✕</button>
              )}
            </div>
            <Legend />
          </div>

          {data.countFlowUnavailable && (
            <div style={{ padding: "6px 10px", background: "var(--bg-elevated)", border: "1px solid var(--color-negative)", color: "var(--color-negative)", fontSize: 11, fontWeight: 600 }}>
              ⚠ count-flow signal unavailable this quarter (data issue) — ranking is running on capital flow alone.
            </div>
          )}

          {gatedMatch && <BelowThreshold row={gatedMatch} />}

          <Board title="Accumulation leaders" accent={FLOW_BLUE} rows={data.accumulation} canon={canon} period={period} highlight={q} rowRefs={rowRefs} onSelectTicker={onSelectTicker} />
          <Board title="Distribution watch" accent={FLOW_RED} rows={data.distribution} canon={canon} period={period} highlight={q} rowRefs={rowRefs} onSelectTicker={onSelectTicker} />

          <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {quarterLabel(data.filingPeriod)} · ranking = recency-weighted count flow + capital flow (bps), z-scored across
            gated names, ×streak ×conviction ×elite. Signal-tier funds only. Fixed sort by score — chevron expands the fund
            ledger; hover the score for its breakdown.
          </div>
        </div>
      )}
    </PanelState>
  );
}

function Legend() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "var(--text-muted)" }}>
      <span>distribution</span>
      <span style={{ width: 14, height: 12, background: FLOW_RED }} />
      <span style={{ width: 14, height: 12, background: flowHeatColor(0) }} />
      <span style={{ width: 14, height: 12, background: FLOW_BLUE }} />
      <span>accumulation</span>
      <span style={{ marginLeft: 6 }}>· cell = net adders−reducers, strip = capital (bps)</span>
    </div>
  );
}

const COLS = "18px 26px minmax(200px, 1fr) repeat(5, 44px) 76px 58px 48px 104px";

function Board({
  title,
  accent,
  rows,
  canon,
  period,
  highlight,
  rowRefs,
  onSelectTicker,
}: {
  title: string;
  accent: string;
  rows: EnrichedRow[];
  canon: string[];
  period: string | null;
  highlight: string;
  rowRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  onSelectTicker: (t: string) => void;
}) {
  return (
    <div style={{ border: "1px solid var(--bg-border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 24, padding: "0 8px", background: "var(--bb-chrome)", color: "#fff", borderLeft: `3px solid ${accent}` }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>{title}</span>
        <span style={{ fontSize: 9, opacity: 0.8 }}>{rows.length} names</span>
      </div>
      {/* Header — real quarter labels for the five heat columns. */}
      <div style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", height: 20, padding: "0 8px", background: "var(--bg-surface)", fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        <span />
        <span>#</span>
        <span>Ticker · why it&apos;s here</span>
        {canon.map((p) => (
          <span key={p} style={{ textAlign: "center" }}>{qShort(p)}</span>
        ))}
        {Array.from({ length: Math.max(0, 5 - canon.length) }).map((_, i) => <span key={`pad${i}`} />)}
        <span style={{ textAlign: "center" }}>ACC</span>
        <span style={{ textAlign: "right" }}>Price</span>
        <span style={{ textAlign: "center" }}>Who</span>
        <span style={{ textAlign: "right" }}>Score</span>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: 12, fontSize: 11, color: "var(--text-muted)" }}>No qualifying names this quarter.</div>
      ) : (
        rows.map((r) => (
          <Row key={r.ticker} r={r} accent={accent} canon={canon} period={period} highlighted={highlight === r.ticker} rowRefs={rowRefs} onSelectTicker={onSelectTicker} />
        ))
      )}
    </div>
  );
}

function Row({
  r,
  accent,
  canon,
  period,
  highlighted,
  rowRefs,
  onSelectTicker,
}: {
  r: EnrichedRow;
  accent: string;
  canon: string[];
  period: string | null;
  highlighted: boolean;
  rowRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  onSelectTicker: (t: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const cells = alignCells(r.cells, canon);
  return (
    <>
      <div
        ref={(el) => {
          rowRefs.current.set(r.ticker, el);
        }}
        onClick={() => onSelectTicker(r.ticker)}
        style={{
          display: "grid",
          gridTemplateColumns: COLS,
          alignItems: "center",
          minHeight: 40,
          padding: "2px 8px",
          borderTop: "1px solid var(--bg-border)",
          cursor: "pointer",
          background: highlighted ? "var(--bg-elevated)" : "transparent",
          outline: highlighted ? `1px solid ${accent}` : "none",
        }}
        className="flows-row"
      >
        <button
          type="button"
          title={expanded ? "Collapse ledger" : "Expand fund ledger"}
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 10, padding: 0, width: 16, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
        >
          ▶
        </button>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{r.rank}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>{r.ticker}</span>
            {Math.abs(r.streak) >= 2 && (
              <span title={`${Math.abs(r.streak)}-quarter same-direction streak`} style={{ fontSize: 9, fontWeight: 700, padding: "0 4px", height: 14, lineHeight: "14px", color: accent, border: `1px solid ${accent}` }}>
                {r.streak > 0 ? "▲" : "▼"}{Math.abs(r.streak)}
              </span>
            )}
            {r.verifyData && (
              <span title="Median holder weight implausibly high or a suspected reported-value unit error — conviction not counted pending review" style={{ fontSize: 8, fontWeight: 700, padding: "0 3px", height: 14, lineHeight: "14px", color: "var(--color-negative)", border: "1px solid var(--color-negative)" }}>VERIFY</span>
            )}
            {r.partialData && (
              <span title="Some holders' filings are missing this quarter — score may be incomplete" style={{ fontSize: 8, fontWeight: 700, padding: "0 3px", height: 14, lineHeight: "14px", color: "var(--color-accent)", border: "1px solid var(--color-accent)" }}>PARTIAL</span>
            )}
            {r.companyName && <span style={{ fontSize: 9, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.companyName}</span>}
          </div>
          <div style={{ fontSize: 9, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.reason}</div>
        </div>
        {cells.map((c, i) => (
          <HeatCellView key={i} cell={c} />
        ))}
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Sparkline values={r.accSeries} label="accumulating" width={70} height={26} />
        </div>
        <PriceCell pct={r.priceReturnPct} />
        <WhoChip r={r} accent={accent} onSelectTicker={onSelectTicker} />
        <ScoreBar r={r} accent={accent} />
      </div>
      {expanded && (
        <div style={{ padding: "0 8px 8px 26px", borderTop: "1px solid var(--bg-border)", background: "var(--bg-surface)" }} onClick={(e) => e.stopPropagation()}>
          <LedgerPanel ticker={r.ticker} period={period} onClose={() => setExpanded(false)} />
        </div>
      )}
    </>
  );
}

/** Align a row's cells to the canonical trailing quarters; missing → null (em-dash). */
function alignCells(cells: HeatCell[], canon: string[]): Array<HeatCell | null> {
  const byPeriod = new Map(cells.map((c) => [c.period, c]));
  return canon.map((p) => byPeriod.get(p) ?? null);
}

/** A heat cell: net-funds count square with a capital-flow (bps) micro-strip beneath. */
function HeatCellView({ cell }: { cell: HeatCell | null }) {
  // Rendering contract lives in heatCellDisplay(): null / no coverage / non-finite
  // netflow → em-dash (muted); only a real computed zero renders "0".
  const disp = heatCellDisplay(cell);
  if (disp.mode === "empty") {
    return (
      <div title={disp.title} style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-base)", border: "1px solid var(--bg-border)", color: "var(--text-muted)", fontSize: 11 }}>{disp.label}</span>
        <span style={{ height: 6, background: "var(--bg-base)", borderLeft: "1px solid var(--bg-base)", borderRight: "1px solid var(--bg-base)" }} />
      </div>
    );
  }
  const bg = flowHeatColor(cell!.netflow, HEAT_SPAN);
  const color = pickTextColor(bg);
  const bps = Math.round(cell!.netflowBps);
  const bpsBg = flowHeatColor(cell!.netflowBps, BPS_SPAN);
  const title = `${quarterLabel(cell!.period)} · ${cell!.period}\n+${cell!.adders} adders / −${cell!.reducers} reducers (net ${disp.label})\ncapital flow ${bps >= 0 ? "+" : ""}${bps} bps · ${cell!.holders} holders`;
  return (
    <div title={title} style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: bg, color, fontSize: 11, fontWeight: 700, fontVariantNumeric: "tabular-nums", border: "1px solid var(--bg-base)" }}>{disp.label}</span>
      <span style={{ height: 6, background: bpsBg, borderLeft: "1px solid var(--bg-base)", borderRight: "1px solid var(--bg-base)" }} />
    </div>
  );
}

/** Signed, colored % price return since period-end. Sign carries the direction so
 *  it is never color-only. */
function PriceCell({ pct }: { pct: number | null }) {
  if (pct == null) return <span style={{ textAlign: "right", fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>—</span>;
  const color = pct > 0 ? "var(--color-positive)" : pct < 0 ? "var(--color-negative)" : "var(--text-secondary)";
  return (
    <span title="split-adjusted price change since period-end" style={{ textAlign: "right", fontSize: 11, fontWeight: 600, color, fontVariantNumeric: "tabular-nums" }}>
      {pct > 0 ? "+" : ""}{pct.toFixed(1)}%
    </span>
  );
}

/** Elite-adder chip (⭐N over last 2 quarters); hover lists the top adders. */
function WhoChip({ r, accent, onSelectTicker }: { r: EnrichedRow; accent: string; onSelectTicker: (t: string) => void }) {
  const title =
    r.topAdders.length > 0
      ? `Top adders (last 2 qtrs):\n${r.topAdders.map((a) => `${a.isElite ? "★ " : ""}${a.fund}${a.netBps != null ? ` +${a.netBps} bps` : ""}${a.deltaPct != null ? ` (${a.deltaPct > 0 ? "+" : ""}${a.deltaPct}% sh)` : ""}`).join("\n")}\n\nClick to open the fund ledger`
      : "No notable adders in the last 2 quarters · click for the fund ledger";
  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <span
        title={title}
        onClick={(e) => { e.stopPropagation(); onSelectTicker(r.ticker); }}
        style={{ cursor: "pointer", fontSize: 10, fontWeight: 700, color: r.eliteAdders2 > 0 ? accent : "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}
      >
        {r.eliteAdders2 > 0 ? `★${r.eliteAdders2}` : "·"}
      </span>
    </div>
  );
}

/** Score bar with a hover tooltip decomposing the 0-100 into its factors. */
function ScoreBar({ r, accent }: { r: EnrichedRow; accent: string }) {
  const title =
    `score ${Math.round(r.score)} (raw ${r.rawScore})\n` +
    `count z ${r.flowzCounts}  ·  capital z ${r.flowzCap}\n` +
    `×streak ${r.streakMult}  ×conviction ${r.convictionMult}  ×elite ${r.eliteMult}\n` +
    `shrinkage ${r.shrinkageFactor} (${r.holders} holders)  ·  median wt ${fmt(r.medianWeight)}%`;
  return (
    <div title={title} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
      <div style={{ width: 52, height: 10, background: "var(--bg-base)", border: "1px solid var(--bg-border)" }}>
        <div style={{ width: `${Math.max(2, r.score)}%`, height: "100%", background: accent }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums", minWidth: 24, textAlign: "right" }}>{Math.round(r.score)}</span>
    </div>
  );
}

function BelowThreshold({ row }: { row: GatedOutRow }) {
  return (
    <div style={{ padding: "6px 10px", background: "var(--bg-elevated)", border: "1px dashed var(--bg-border)", fontSize: 11, color: "var(--text-secondary)" }}>
      <b style={{ color: "var(--text-primary)" }}>{row.ticker}</b>
      {row.companyName ? ` · ${row.companyName}` : ""} — below threshold: {row.reason}.{" "}
      <span style={{ color: "var(--text-muted)" }}>
        (holders {row.holders}, wflow {row.wflow.toFixed(1)}, wflow_bps {row.wflowBps.toFixed(1)})
      </span>
    </div>
  );
}
