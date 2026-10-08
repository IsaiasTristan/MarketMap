"use client";
/**
 * Screen 2 — the research queue table.
 *
 * One row per name, every number read straight off a materialized
 * RevisionScreenRow. Column headers are in plain language; the underlying
 * field name is in the `title` attribute for debugging. Only the rank column
 * carries a bar — the rest are context and stay flat so the eye goes to the
 * one thing the queue is sorted on.
 */
import Link from "next/link";
import { CenteredBar, DecileStrip, Sparkline, Tag, engineTagTone, signColor } from "../primitives";
import { MetricTip } from "../MetricTip";
import { fmtCap, fmtPctOrNm } from "@/lib/revision/screen-format";
import type { RevMetricId } from "@/lib/revision/metric-registry";
import type { ScreenRowDto } from "@/server/services/revision/revision-screen.service";
import { REVISION_BASE } from "./useScreens";

/** Below this the panel behind a score is one or two analysts — flagged amber. */
const THIN_COVERAGE = 4;
/** Amber below this cap: a score that only works in micro caps is not tradeable. */
const SMALL_CAP = 2e9;
/** Orange inside this many days: the print will re-write the estimate base. */
const ER_SOON = 14;

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "3px 6px",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: 0.4,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
  verticalAlign: "bottom",
  lineHeight: 1.25,
};
const td: React.CSSProperties = {
  padding: "3px 6px",
  fontSize: 11,
  borderTop: "1px solid var(--chrome-border)",
  whiteSpace: "nowrap",
};
const tdNum: React.CSSProperties = { ...td, textAlign: "right" };

function Th({
  id,
  children,
  field,
  align = "left",
}: {
  id: RevMetricId;
  children: React.ReactNode;
  field: string;
  align?: "left" | "right" | "center";
}) {
  return (
    <th style={{ ...th, textAlign: align }} title={field}>
      <MetricTip id={id}>{children}</MetricTip>
    </th>
  );
}

function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
}

export function QueueTable({
  rows,
  startIndex,
  side,
}: {
  rows: ScreenRowDto[];
  startIndex: number;
  side: "long" | "short" | "both";
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1500 }}>
        <thead>
          <tr style={{ background: "var(--bg-surface)" }}>
            <th style={{ ...th, textAlign: "right" }}>#</th>
            <Th id="rank" field="ticker">
              Ticker
            </Th>
            <Th id="breadthZ" field="subsector">
              Industry
            </Th>
            <Th id="ptRevOrthRaw" field="mktCap" align="right">
              Size
            </Th>
            <Th id="analystCount" field="analystCount" align="right">
              #&nbsp;Analysts
            </Th>
            <Th id="ptRevOrthZ" field="ptRevOrthZ">
              Target raises vs peers
              <div style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>score, ex price move</div>
            </Th>
            <Th id="ptUpDown" field="ptUp / ptDown" align="right">
              Analysts raised / cut
            </Th>
            <Th id="epsFy1Chg4w" field="epsFy1Chg4w" align="right">
              Avg EPS est.
              <div style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>change 4w</div>
            </Th>
            <Th id="revFy1Chg4w" field="revFy1Chg4w" align="right">
              Avg sales est.
              <div style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>change 4w</div>
            </Th>
            <Th id="ratingMoves" field="ratingUp / ratingDown / ratingInit">
              Buy/sell rating moves
            </Th>
            <Th id="ptRevOrthZ" field="ptRevOrthZHist">
              Score, last 13 weeks
            </Th>
            <Th id="weeksInTopDecile" field="decileHist">
              Weeks in top 10%
            </Th>
            <Th id="px4wZ" field="pxZ" align="right">
              Stock vs peers 4w
            </Th>
            <Th id="gapScore" field="gap" align="right">
              Unpriced gap
            </Th>
            <Th id="nextEr" field="daysToEarnings" align="right">
              Days to earnings
            </Th>
            <Th id="engineTags" field="e2Tag">
              E2 business inflecting?
            </Th>
            <Th id="engineTags" field="e3Tag">
              E3 funds buying?
            </Th>
            <Th id="engineTags" field="e4Tag">
              E4 factor driven?
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const short = (r.ptRevOrthZ ?? 0) < 0;
            const thin = r.analystCount <= THIN_COVERAGE;
            const small = r.mktCap !== null && r.mktCap < SMALL_CAP;
            const erSoon = r.daysToEarnings !== null && r.daysToEarnings <= ER_SOON;
            return (
              <tr key={r.ticker} style={{ background: i % 2 ? "var(--bg-base)" : "transparent" }}>
                <td style={{ ...tdNum, color: "var(--text-muted)", fontSize: 10 }}>{startIndex + i + 1}</td>
                <td style={td}>
                  <Link
                    href={`${REVISION_BASE}/${r.ticker}`}
                    style={{ color: "var(--text-primary)", fontWeight: 700, textDecoration: "none" }}
                  >
                    {r.ticker}
                  </Link>
                  {(r.isNewTop || r.isNewBottom) && (
                    <span style={{ marginLeft: 4 }}>
                      <Tag label="NEW" tone={r.isNewTop ? "positive" : "negative"} title="Entered the decile this week" />
                    </span>
                  )}
                  {r.companyName && (
                    <div style={{ fontSize: 9, color: "var(--text-muted)", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {r.companyName}
                    </div>
                  )}
                </td>
                <td style={{ ...td, fontSize: 10, color: "var(--text-secondary)" }}>{r.subsector}</td>
                <td className="bb-num" style={{ ...tdNum, color: small ? "var(--color-accent)" : undefined }}>
                  {fmtCap(r.mktCap)}
                </td>
                <td className="bb-num" style={{ ...tdNum, color: thin ? "var(--color-accent)" : undefined }}>
                  {r.analystCount}
                </td>
                <td style={td}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <CenteredBar value={r.ptRevOrthZ} />
                    <span className="bb-num" style={{ fontWeight: 700, color: signColor(r.ptRevOrthZ) }}>
                      {num(r.ptRevOrthZ)}
                    </span>
                  </span>
                </td>
                <td className="bb-num" style={tdNum}>
                  <span style={{ color: r.ptUp > 0 ? "var(--color-positive)" : "var(--text-muted)" }}>{r.ptUp}</span>
                  <span style={{ color: "var(--text-muted)" }}> / </span>
                  <span style={{ color: r.ptDown > 0 ? "var(--color-negative)" : "var(--text-muted)" }}>{r.ptDown}</span>
                  <span style={{ color: "var(--text-muted)", fontSize: 9 }}> of {r.analystCount}</span>
                </td>
                <td className="bb-num" style={{ ...tdNum, color: signColor(r.epsFy1Chg4w) }}>
                  {fmtPctOrNm(r.epsFy1Chg4w)}
                </td>
                <td className="bb-num" style={{ ...tdNum, color: signColor(r.revFy1Chg4w) }}>
                  {fmtPctOrNm(r.revFy1Chg4w)}
                </td>
                <td style={{ ...td, fontSize: 9, color: "var(--text-muted)" }}>
                  {r.ratingUp === 0 && r.ratingDown === 0 && r.ratingInit === 0 ? (
                    "·"
                  ) : (
                    <>
                      {r.ratingUp > 0 && <span style={{ color: "var(--color-positive)" }}>{r.ratingUp} upg </span>}
                      {r.ratingDown > 0 && <span style={{ color: "var(--color-negative)" }}>{r.ratingDown} dng </span>}
                      {r.ratingInit > 0 && <span>{r.ratingInit} init</span>}
                    </>
                  )}
                </td>
                <td style={td}>
                  <Sparkline values={r.ptRevOrthZHist} />
                </td>
                <td style={td}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <DecileStrip decileHist={r.decileHist} target={short ? 1 : 10} />
                    <span className="bb-num" style={{ fontSize: 10, color: "var(--text-muted)" }}>
                      {r.weeksInTopDecile}
                    </span>
                  </span>
                </td>
                <td className="bb-num" style={{ ...tdNum, color: signColor(r.pxZ) }}>
                  {num(r.pxZ)}
                </td>
                <td className="bb-num" style={{ ...tdNum, fontWeight: 700, color: signColor(r.gap) }}>
                  {num(r.gap)}
                </td>
                <td
                  className="bb-num"
                  style={{ ...tdNum, color: erSoon ? "var(--color-accent)" : "var(--text-muted)" }}
                >
                  {r.daysToEarnings === null ? "—" : r.daysToEarnings}
                </td>
                {[r.e2Tag, r.e3Tag, r.e4Tag].map((tag, k) => (
                  <td key={k} style={td}>
                    {tag ? <Tag label={tag} tone={engineTagTone(tag)} /> : <span style={{ color: "var(--text-muted)" }}>·</span>}
                  </td>
                ))}
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={18} style={{ ...td, color: "var(--text-muted)", padding: 20, textAlign: "center" }}>
                No names clear these filters this week.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <QueueLegend side={side} />
    </div>
  );
}

function QueueLegend({ side }: { side: "long" | "short" | "both" }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 16,
        padding: "6px 8px",
        marginTop: 4,
        fontSize: 9,
        color: "var(--text-muted)",
        borderTop: "1px solid var(--chrome-border)",
      }}
    >
      <span style={{ color: "var(--color-accent)" }}>Amber</span>
      <span>= under $2B, four or fewer analysts, or earnings inside 14 days — read the score with more care.</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <DecileStrip decileHist={[10, 10, 0, 10, 10, 10]} target={side === "short" ? 1 : 10} />
        <span>WEEKS IN TOP 10% — one block per week, oldest left, filled where the name was in the strongest decile.</span>
      </span>
      <span>GAP = analyst score minus stock-move score.</span>
    </div>
  );
}
