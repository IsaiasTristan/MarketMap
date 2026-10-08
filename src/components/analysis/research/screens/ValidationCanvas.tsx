"use client";
/**
 * Validation canvas — does the queue the screens serve actually work?
 *
 * The headline is funnel precision, not universe IC: a cross-sectional IC of
 * 0.01 says nothing about the 25 names a user reads. Everything here is
 * measured on the SAME rank the screens sort by, over the full Leg-B grid,
 * entered at the t+1 close on both ends. Nothing renders as a headline until
 * the effective-week count clears the minimum; below it the tile reads
 * ACCRUING so a thin sample is never mistaken for a result.
 */
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { PanelState } from "@/components/analysis/ui/PanelState";
import { MetricTip } from "../MetricTip";
import type { FunnelBlock, FunnelValidationPayload } from "@/server/services/revision/revision-funnel.service";
import { useFunnelValidation } from "./useScreens";

const tickStyle = { fontSize: 9, fill: "var(--color-accent)" };
const muted = "var(--text-muted)";

const pct = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(digits)}%`;
const num = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? "—" : v.toFixed(digits);

function signColor(v: number | null | undefined): string {
  if (v === null || v === undefined) return "var(--text-primary)";
  return v > 0 ? "var(--color-positive)" : v < 0 ? "var(--color-negative)" : "var(--text-primary)";
}

// ── Headline tiles ───────────────────────────────────────────────────────────

function Tile({
  label,
  metricId,
  value,
  valueColor,
  sub,
  foot,
  accruing,
}: {
  label: string;
  metricId: Parameters<typeof MetricTip>[0]["id"];
  value: string;
  valueColor?: string;
  sub?: string;
  foot?: string;
  accruing?: string | null;
}) {
  return (
    <div style={{ background: "var(--bg-surface)", padding: "6px 10px", minWidth: 0 }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: muted, textTransform: "uppercase" }}>
        <MetricTip id={metricId}>{label}</MetricTip>
      </div>
      {accruing ? (
        <>
          <div className="bb-num" style={{ fontSize: 13, fontWeight: 700, color: "var(--color-accent)" }}>
            ACCRUING
          </div>
          <div style={{ fontSize: 8.5, color: muted }}>{accruing}</div>
        </>
      ) : (
        <>
          <div className="bb-num" style={{ fontSize: 16, fontWeight: 700, color: valueColor ?? "var(--text-primary)" }}>
            {value}
          </div>
          {sub && <div style={{ fontSize: 9, color: muted }}>{sub}</div>}
          {foot && <div style={{ fontSize: 8.5, color: muted }}>{foot}</div>}
        </>
      )}
    </div>
  );
}

function HeadlineTiles({ payload, block }: { payload: FunnelValidationPayload; block: FunnelBlock }) {
  const { topK, overlap, nextPrint } = block;
  // One gate for every headline: below the minimum effective weeks the number
  // exists but is not evidence, so it is not shown as one.
  const accruing = payload.headlineReady
    ? null
    : `${payload.headlineEffectiveWeeks ?? 0} of ${payload.headlineMinWeeks} effective weeks`;
  const edge =
    topK.medianReturn !== null && topK.randomMedian !== null ? topK.medianReturn - topK.randomMedian : null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(178px, 1fr))",
        gap: 1,
        background: "var(--chrome-border)",
        border: "1px solid var(--chrome-border)",
      }}
    >
      <Tile
        label={`Top ${topK.k} vs a random ${topK.k}`}
        metricId="topKPrecision"
        accruing={accruing}
        value={edge === null ? "—" : `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(2)}pp`}
        valueColor={signColor(edge)}
        sub={`${pct(topK.medianReturn)} vs ${pct(topK.randomMedian)} median, ${block.horizonWeeks}w`}
        foot={
          topK.percentileVsRandom === null
            ? undefined
            : `beats ${(topK.percentileVsRandom * 100).toFixed(0)}% of ${topK.draws.toLocaleString()} random baskets · ${topK.weeks} weeks`
        }
      />
      <Tile
        label={`Top ${topK.k} hit rate`}
        metricId="topKHitRate"
        accruing={accruing}
        value={pct(topK.hitRate, 1)}
        valueColor={
          topK.hitRate !== null && topK.randomHitRate !== null
            ? signColor(topK.hitRate - topK.randomHitRate)
            : undefined
        }
        sub={`vs ${pct(topK.randomHitRate, 1)} random`}
        foot="share of picks that beat their peer group"
      />
      <Tile
        label="Week-to-week overlap"
        metricId="queueOverlap"
        value={pct(overlap.meanJaccard, 0)}
        sub={
          overlap.meanArrivals === null ? undefined : `${overlap.meanArrivals.toFixed(1)} new names a week`
        }
        foot={`${overlap.transitions} week transitions`}
      />
      <Tile
        label="Next earnings beat"
        metricId="nextPrintOutcome"
        accruing={accruing}
        value={pct(nextPrint.surpriseBeatRate, 1)}
        valueColor={
          nextPrint.surpriseBeatRate !== null && nextPrint.baseSurpriseBeatRate !== null
            ? signColor(nextPrint.surpriseBeatRate - nextPrint.baseSurpriseBeatRate)
            : undefined
        }
        sub={`vs ${pct(nextPrint.baseSurpriseBeatRate, 1)} universe`}
        foot="of the top names' next reports"
      />
      <Tile
        label="Still being raised next week"
        metricId="nextPrintOutcome"
        accruing={accruing}
        value={pct(nextPrint.followThroughRate, 1)}
        valueColor={
          nextPrint.followThroughRate !== null && nextPrint.baseFollowThroughRate !== null
            ? signColor(nextPrint.followThroughRate - nextPrint.baseFollowThroughRate)
            : undefined
        }
        sub={`vs ${pct(nextPrint.baseFollowThroughRate, 1)} universe`}
        foot="the signal should predict the next revision, not just the next tick"
      />
    </div>
  );
}

// ── Decile bars + rolling IC ─────────────────────────────────────────────────

function DecileBars({ block }: { block: FunnelBlock }) {
  const data = block.decileReturns.map((d) => ({
    ...d,
    pctReturn: d.meanReturn === null ? null : d.meanReturn * 100,
  }));
  return (
    <ResponsiveContainer width="100%" height={190}>
      <BarChart data={data} margin={{ top: 8, right: 10, bottom: 18, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--chrome-border)" vertical={false} />
        <XAxis
          dataKey="decile"
          tick={tickStyle}
          axisLine={{ stroke: "var(--color-accent)" }}
          tickLine={false}
          label={{
            value: "1 = analysts cutting hardest        10 = raising hardest",
            position: "insideBottom",
            offset: -12,
            style: { fontSize: 9, fill: muted },
          }}
        />
        <YAxis
          tick={tickStyle}
          axisLine={{ stroke: "var(--color-accent)" }}
          tickLine={false}
          width={40}
          tickFormatter={(v: number) => `${v.toFixed(1)}%`}
        />
        <Tooltip
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
          contentStyle={{ background: "var(--bg-base)", border: "1px solid var(--chrome-border)", fontSize: 10 }}
          formatter={(v, _n, e) => {
            const row = (e as { payload: (typeof data)[number] }).payload;
            return [
              `${Number(v).toFixed(2)}% over ${block.horizonWeeks}w · ${row.tickerWeeks.toLocaleString()} ticker-weeks`,
              `bucket ${row.decile}`,
            ];
          }}
          labelFormatter={() => ""}
        />
        <ReferenceLine y={0} stroke="#585860" />
        <Bar dataKey="pctReturn" isAnimationActive={false}>
          {data.map((d) => (
            <Cell
              key={d.decile}
              fill={(d.pctReturn ?? 0) >= 0 ? "var(--color-positive)" : "var(--color-negative)"}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function RollingIc({ block }: { block: FunnelBlock }) {
  const data = block.rollingIc.filter((p) => p.ic !== null);
  return (
    <ResponsiveContainer width="100%" height={170}>
      <LineChart data={data} margin={{ top: 8, right: 10, bottom: 4, left: -14 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--chrome-border)" vertical={false} />
        <XAxis dataKey="date" tick={tickStyle} axisLine={{ stroke: "var(--color-accent)" }} tickLine={false} minTickGap={50} />
        <YAxis
          tick={tickStyle}
          axisLine={{ stroke: "var(--color-accent)" }}
          tickLine={false}
          width={42}
          domain={[-0.4, 0.4]}
          tickFormatter={(v: number) => v.toFixed(1)}
        />
        <Tooltip
          contentStyle={{ background: "var(--bg-base)", border: "1px solid var(--chrome-border)", fontSize: 10 }}
          formatter={(v) => [Number(v).toFixed(3), "relationship"]}
        />
        <ReferenceLine y={0} stroke="#585860" />
        <Line type="monotone" dataKey="ic" stroke="var(--color-accent)" strokeWidth={1.1} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Tables ───────────────────────────────────────────────────────────────────

const th: React.CSSProperties = {
  textAlign: "right",
  padding: "3px 8px",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: muted,
  borderBottom: "1px solid var(--chrome-border)",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = { textAlign: "right", padding: "3px 8px", fontSize: 10 };

/** The horizon the live rank is built on; the others are decay context. */
const RANK_HORIZON = 4;

function IcByHorizonTable({ payload, viewHorizon }: { payload: FunnelValidationPayload; viewHorizon: number }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={{ ...th, textAlign: "left" }}>Holding period</th>
          <th style={th}>Relationship (IC)</th>
          <th style={th}>
            <MetricTip id="hacT">t-stat (overlap-corrected)</MetricTip>
          </th>
          <th style={th}>t-stat (naive)</th>
          <th style={th}>Independent weeks</th>
          <th style={th}>Weeks measured</th>
        </tr>
      </thead>
      <tbody>
        {payload.icByHorizon.map((r) => {
          const ready = r.effectiveWeeks !== null && r.effectiveWeeks >= payload.headlineMinWeeks;
          return (
            <tr
              key={r.horizonWeeks}
              style={{
                borderBottom: "1px solid var(--chrome-border)",
                background: r.horizonWeeks === viewHorizon ? "rgba(240,182,93,0.07)" : undefined,
              }}
            >
              <td style={{ ...td, textAlign: "left", fontWeight: r.horizonWeeks === RANK_HORIZON ? 700 : 400 }}>
                {r.horizonWeeks} week{r.horizonWeeks === 1 ? "" : "s"}
                {r.horizonWeeks === RANK_HORIZON && (
                  <span style={{ fontSize: 8.5, color: "var(--color-accent)" }}> · ranked on</span>
                )}
              </td>
              <td className="bb-num" style={{ ...td, color: signColor(r.meanIC) }}>
                {num(r.meanIC, 4)}
              </td>
              <td className="bb-num" style={{ ...td, fontWeight: 700 }}>
                {num(r.hacT)}
              </td>
              <td className="bb-num" style={{ ...td, color: muted }}>
                {num(r.naiveT)}
              </td>
              <td className="bb-num" style={{ ...td, color: ready ? "var(--text-primary)" : "var(--color-accent)" }}>
                {r.effectiveWeeks ?? "—"}
              </td>
              <td className="bb-num" style={{ ...td, color: muted }}>
                {r.weeks}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const CUT_LABELS: Record<string, string> = {
  "cap:LOW": "Smallest third by size",
  "cap:MID": "Middle third by size",
  "cap:HIGH": "Largest third by size",
  "cov:THIN": "1–4 analysts",
  "cov:MID": "5–10 analysts",
  "cov:DEEP": "11+ analysts",
  "er:0-14d": "Within 14 days after a report",
  "er:rest": "Everywhere else",
};
/** Cuts read in a fixed order so the eye compares rows, not labels. */
const CUT_ORDER = ["cap:LOW", "cap:MID", "cap:HIGH", "cov:THIN", "cov:MID", "cov:DEEP", "er:0-14d", "er:rest"];

function CutTable({
  title,
  metricId,
  rows,
}: {
  title: string;
  metricId: Parameters<typeof MetricTip>[0]["id"];
  rows: FunnelBlock["capTerciles"];
}) {
  const sorted = [...rows].sort((a, b) => CUT_ORDER.indexOf(a.label) - CUT_ORDER.indexOf(b.label));
  return (
    <div>
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: muted, textTransform: "uppercase", padding: "0 8px 2px" }}>
        <MetricTip id={metricId}>{title}</MetricTip>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Slice</th>
            <th style={th}>Relationship</th>
            <th style={th}>Share of top 10%</th>
            <th style={th}>Ticker-weeks</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.label} style={{ borderBottom: "1px solid var(--chrome-border)" }}>
              <td style={{ ...td, textAlign: "left" }}>{CUT_LABELS[r.label] ?? r.label}</td>
              <td className="bb-num" style={{ ...td, color: signColor(r.meanIC) }}>
                {num(r.meanIC, 4)}
              </td>
              <td className="bb-num" style={td}>
                {pct(r.topDecileShare, 1)}
              </td>
              <td className="bb-num" style={{ ...td, color: muted }}>
                {r.tickerWeeks.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SurvivorshipNotePanel({ payload }: { payload: FunnelValidationPayload }) {
  const s = payload.survivorship;
  const worst = [...s.missingByDate].sort((a, b) => b.missing - a.missing)[0];
  return (
    <div style={{ fontSize: 10, color: "var(--text-primary)", lineHeight: 1.7, padding: "2px 8px" }}>
      The universe holds {s.labUniverse.toLocaleString()} tickers as listed today. On an average historical week{" "}
      <span className="bb-num" style={{ color: "var(--color-accent)", fontWeight: 700 }}>
        {s.meanMissing === null ? "—" : Math.round(s.meanMissing).toLocaleString()}
      </span>{" "}
      of them have no row{worst ? ` (worst week ${worst.date}, ${worst.missing.toLocaleString()} missing)` : ""}, and{" "}
      <span className="bb-num" style={{ color: "var(--color-accent)", fontWeight: 700 }}>
        {s.droppedNoEntry.toLocaleString()}
      </span>{" "}
      ticker-weeks were dropped for want of a tradeable next-day close.
      <div style={{ color: muted, fontSize: 9 }}>
        A company delisted mid-sample simply has no rows, so its outcome — usually a bad one — never enters these
        statistics. This is a flag, not a correction: only backfilling delisted names removes the bias.
      </div>
    </div>
  );
}

// ── Canvas ───────────────────────────────────────────────────────────────────

export function ValidationCanvas() {
  const { data, state, error } = useFunnelValidation();
  const [horizon, setHorizon] = useState<number | null>(null);

  const blocks = data?.funnel ?? [];
  const block = blocks.find((b) => b.horizonWeeks === horizon) ?? blocks[0];

  return (
    <PanelState state={state} error={error}>
      {data && block && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 9, color: muted }}>
            <span>
              Measured on <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>{data.rankSignal}</span> — the
              same rank the queue sorts by — over {data.grid.weeks} weeks, {data.grid.from} to {data.grid.to}.
            </span>
            <span>Entry: {data.entry}.</span>
            <div style={{ flex: 1 }} />
            <span style={{ letterSpacing: 0.4, textTransform: "uppercase" }}>Holding period</span>
            <div style={{ display: "flex", gap: 1 }}>
              {blocks.map((b) => {
                const active = b.horizonWeeks === block.horizonWeeks;
                return (
                  <button
                    key={b.horizonWeeks}
                    type="button"
                    onClick={() => setHorizon(b.horizonWeeks)}
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      padding: "2px 10px",
                      cursor: "pointer",
                      color: active ? "#000" : "var(--text-muted)",
                      background: active ? "var(--color-accent)" : "var(--bg-surface)",
                      border: "1px solid var(--chrome-border)",
                    }}
                  >
                    {b.horizonWeeks}w
                  </button>
                );
              })}
            </div>
          </div>

          <HeadlineTiles payload={data} block={block} />

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 6, alignItems: "start" }}>
            <ChartCard
              title={`Average ${block.horizonWeeks}-week return by score bucket`}
              subtitle="Each bucket is a tenth of the universe, sorted by the score. Returns are measured against the stock's own peer group."
            >
              <DecileBars block={block} />
            </ChartCard>
            <ChartCard
              title={`Does the score predict the next ${block.horizonWeeks} weeks?`}
              subtitle="One point per week. 0 means no relationship; the line wandering either side of 0 is what a weak-but-real signal looks like."
            >
              <RollingIc block={block} />
            </ChartCard>
          </div>

          <ChartCard
            title="How long the edge lasts"
            subtitle="The same measurement at every holding period. The overlap-corrected t-stat is the honest one: consecutive weekly readings of a multi-week return share most of their data."
          >
            <IcByHorizonTable payload={data} viewHorizon={block.horizonWeeks} />
          </ChartCard>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 6, alignItems: "start" }}>
            <ChartCard title="Does it work on small companies" subtitle="Split by company size.">
              <CutTable title="By company size" metricId="capCut" rows={block.capTerciles} />
            </ChartCard>
            <ChartCard title="Does it work on thinly covered names" subtitle="Split by how many analysts publish a target.">
              <CutTable title="By analyst coverage" metricId="coverageCut" rows={block.coverageTerciles} />
            </ChartCard>
            <ChartCard
              title="Is this just post-earnings drift"
              subtitle="Split by whether the week falls just after a report."
            >
              <CutTable title="By earnings window" metricId="earningsWindowCut" rows={block.earningsWindow} />
            </ChartCard>
          </div>

          <ChartCard title="What this measurement cannot see" subtitle="Delisted companies.">
            <SurvivorshipNotePanel payload={data} />
          </ChartCard>

          <div style={{ fontSize: 8.5, color: muted, padding: "0 4px" }}>
            Computed {new Date(data.generatedAt).toISOString().slice(0, 16).replace("T", " ")}Z · smoothed variants of
            the score are shown on the queue as trajectory sparklines only; they are not part of the rank.
          </div>
        </div>
      )}
    </PanelState>
  );
}
