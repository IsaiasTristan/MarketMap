"use client";
/**
 * VALIDATION — is the signal working? Stat strip, forward-return-by-decile
 * bars, rolling IC line, per-signal attribution, regime line. Every figure is
 * labeled with its effective window and source (FULL vs LEG-B ONLY); blocks
 * below their minimum history render the terminal accruing placeholder and
 * fill in automatically as Leg A deepens.
 */
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
import { useRevision } from "./useRevision";
import { MetricTip } from "./MetricTip";
import { InsufficientHistory, StatStrip, WindowTag, fmtPctSigned, fmtZ } from "./researchUi";

interface VariantStats {
  weeklyIC: Array<{ date: string; ic: number | null; n: number }>;
  rollingIC4w: Array<{ date: string; ic: number | null; weeksUsed: number }>;
  meanIC: number | null;
  tStat: number | null;
  icWeeks: number;
  deciles: { buckets: Array<{ decile: number; n: number; meanFwd: number | null }>; d10d1: number | null; d10HitRate: number | null; n: number };
  effectiveWeeks: number;
  sufficient: boolean;
}

interface ValidationPayload {
  snapshotDate: string;
  horizonWeeks: number;
  minWeeks: number;
  effectiveWeeks: { full: number; legB: number; price: number };
  fullComposite: VariantStats | null;
  legBComposite: VariantStats | null;
  perSignal: Array<{ signal: string; source: string; ic: number | null; weeks: number }>;
  postFlagDrift: {
    horizonsWeeks: number[];
    newLong: Array<number | null>;
    newShort: Array<number | null>;
    longFlags: number;
    shortFlags: number;
  };
  regime: { positiveWeeks: number; totalWeeks: number; window: number } | null;
  icCurrent: number | null;
  icLongRun: number | null;
  icSource: "FULL" | "LEG_B" | null;
}

const tickStyle = { fontSize: 9, fill: "var(--text-muted)" };
const tooltipStyle = {
  background: "var(--bg-base)",
  border: "1px solid var(--chrome-border)",
  fontSize: 10,
};

const SIGNAL_LABEL: Record<string, string> = {
  estimateBreadth: "BRD",
  epsRevision: "EPS",
  ptRevision: "PT",
  ratingMomentum: "RTG",
  revenueRevision: "REV",
};

export function ValidationPanel() {
  const { data, state, error } = useRevision<ValidationPayload>(
    ["research-validation"],
    "/api/analysis/research/validation",
  );

  return (
    <PanelState state={state} error={error}>
      {data && (() => {
        // Headline variant: FULL once it's sufficient, else the Leg-B reconstruction.
        const variant = data.fullComposite?.sufficient ? data.fullComposite : data.legBComposite;
        const source: "FULL" | "LEG_B" = data.fullComposite?.sufficient ? "FULL" : "LEG_B";
        const weeks = variant?.effectiveWeeks ?? 0;
        const driftAt4 = data.postFlagDrift.newLong[data.postFlagDrift.horizonsWeeks.indexOf(4)] ?? null;
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <StatStrip
              items={[
                {
                  metricId: "d10d1",
                  label: `D10−D1 ${data.horizonWeeks}w`,
                  value: variant ? fmtPctSigned(variant.deciles.d10d1) : "—",
                  sub: `${weeks}W · ${source === "FULL" ? "FULL" : "LEG-B"}`,
                  tone: (variant?.deciles.d10d1 ?? 0) > 0 ? "positive" : "negative",
                },
                {
                  metricId: "d10HitRate",
                  label: "D10 hit %",
                  value: variant?.deciles.d10HitRate !== null && variant ? `${((variant.deciles.d10HitRate ?? 0) * 100).toFixed(0)}%` : "—",
                  sub: `${variant?.deciles.n ?? 0} pooled obs`,
                },
                {
                  metricId: "newFlagDrift",
                  label: "New-flag drift 4w",
                  value: driftAt4 !== null ? fmtPctSigned(driftAt4) : "—",
                  sub: `${data.postFlagDrift.longFlags}L / ${data.postFlagDrift.shortFlags}S flags`,
                },
                {
                  metricId: "ic26wMean",
                  label: "IC 26w mean",
                  value: data.icLongRun !== null ? fmtZ(data.icLongRun, 3) : "—",
                  sub: data.icSource === "LEG_B" ? "LEG-B ONLY" : "FULL",
                  tone: (data.icLongRun ?? 0) > 0 ? "positive" : "negative",
                },
                {
                  metricId: "icTStat",
                  label: "T-stat",
                  value: variant?.tStat !== null && variant ? variant.tStat.toFixed(2) : "—",
                  sub: `${variant?.icWeeks ?? 0} weekly ICs`,
                },
              ]}
            />

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 8 }}>
              <ChartCard
                title="Fwd 4w return by decile"
                subtitle="peer-relative · pooled across validation weeks"
                action={variant ? <WindowTag weeks={weeks} source={source} /> : undefined}
                style={{ overflow: "visible" }}
              >
                {!variant ? (
                  <InsufficientHistory have={data.effectiveWeeks.full} need={data.minWeeks} />
                ) : (
                  <div style={{ height: 200 }}>
                    <ResponsiveContainer>
                      <BarChart data={variant.deciles.buckets} margin={{ top: 8, right: 12, bottom: 0, left: -14 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--chrome-border)" vertical={false} />
                        <XAxis dataKey="decile" tick={tickStyle} axisLine={{ stroke: "var(--chrome-border)" }} tickLine={false} />
                        <YAxis tick={tickStyle} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${(v * 100).toFixed(1)}%`} />
                        <ReferenceLine y={0} stroke="#464646" />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          formatter={(v) => [fmtPctSigned(typeof v === "number" ? v : null), "mean fwd 4w"]}
                          labelFormatter={(l) => `decile ${l}`}
                        />
                        <Bar dataKey="meanFwd" isAnimationActive={false}>
                          {variant.deciles.buckets.map((b) => (
                            <Cell key={b.decile} fill={(b.meanFwd ?? 0) >= 0 ? "var(--color-positive)" : "var(--color-negative)"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </ChartCard>

              <ChartCard
                title="Rolling 4w IC"
                subtitle="weekly Spearman IC vs fwd 4w peer-relative return, 4w smoothed"
                action={variant ? <WindowTag weeks={weeks} source={source} /> : undefined}
                style={{ overflow: "visible" }}
              >
                {!variant ? (
                  <InsufficientHistory have={data.effectiveWeeks.full} need={data.minWeeks} />
                ) : (
                  <div style={{ height: 200 }}>
                    <ResponsiveContainer>
                      <LineChart data={variant.rollingIC4w} margin={{ top: 8, right: 12, bottom: 0, left: -14 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--chrome-border)" />
                        <XAxis dataKey="date" tick={tickStyle} axisLine={{ stroke: "var(--chrome-border)" }} tickLine={false} minTickGap={40} />
                        <YAxis tick={tickStyle} axisLine={false} tickLine={false} />
                        <ReferenceLine y={0} stroke="#464646" />
                        {data.icLongRun !== null && (
                          <ReferenceLine y={data.icLongRun} stroke="var(--color-accent)" strokeDasharray="4 4" />
                        )}
                        <Tooltip
                          contentStyle={tooltipStyle}
                          formatter={(v) => [typeof v === "number" ? v.toFixed(3) : "—", "IC (4w)"]}
                        />
                        <Line type="monotone" dataKey="ic" stroke="var(--color-info)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </ChartCard>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 14, fontSize: 11, padding: "2px 2px" }}>
              <MetricTip id="perSignalIc">
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5, color: "var(--text-muted)" }}>PER-SIGNAL IC</span>
              </MetricTip>
              {data.perSignal.every((s) => s.ic === null) ? (
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  INSUFFICIENT HISTORY — {data.effectiveWeeks.full} OF {data.minWeeks} WKS MIN · ACCRUING (needs Leg-A forward returns)
                </span>
              ) : (
                data.perSignal.map((s) => (
                  <span key={s.signal} className="bb-num" style={{ color: (s.ic ?? 0) >= 0 ? "var(--color-positive)" : "var(--color-negative)" }}>
                    <span style={{ color: "var(--text-muted)", fontWeight: 700 }}>{SIGNAL_LABEL[s.signal] ?? s.signal}</span>{" "}
                    {s.ic !== null ? fmtZ(s.ic, 3) : "—"}
                  </span>
                ))
              )}
            </div>

            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
              <MetricTip id="regime">
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>REGIME</span>
              </MetricTip>{" "}
              {data.regime
                ? `IC positive ${data.regime.positiveWeeks} of last ${data.regime.totalWeeks} weeks (${source === "LEG_B" ? "LEG-B ONLY" : "FULL"})`
                : "—"}
              {" · "}effective windows: FULL {data.effectiveWeeks.full}w · LEG-B {data.effectiveWeeks.legB}w · prices {data.effectiveWeeks.price}w
              {" · full-composite stats replace Leg-B automatically at "}{data.minWeeks}{"w"}
            </div>
          </div>
        );
      })()}
    </PanelState>
  );
}
