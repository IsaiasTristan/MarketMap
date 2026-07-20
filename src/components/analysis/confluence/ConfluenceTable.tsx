"use client";
/**
 * CONFLUENCE table — the ranked stacking board. Rank = position in the FULL
 * server-ranked set (stable under filtering). Three stack cells per row
 * (green long / red short / gray neutral / hollow-dashed no-coverage) hover
 * their source's key number + as-of and deep-link to that source's tab
 * pre-filtered. Heat only on the decision column (rev gap); context columns
 * stay flat. Never renders a blended score.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { stageChipLabel, type SignalState, type Stage } from "@/lib/analysis/confluence/rules";
import type { ConfluenceRowDto, ConfluencePayload } from "@/server/services/confluence.service";
import { CONFLUENCE_THRESHOLDS } from "@/lib/analysis/confluence/config";
import { ConfluenceMetricTip } from "./ConfluenceMetricTip";

const PAGE = 50;

const STAGE_CHIP_COLOR: Record<Stage, string> = {
  FULL_STACK: "var(--color-positive)",
  CROWDED: "var(--color-warning, #ffb000)",
  PLUS_REVISIONS: "#5aa0ff",
  R_PLUS_13F: "#8f86e8",
  F_PLUS_13F: "#b57edb",
  SINGLE: "var(--text-muted)",
  CONFLICT: "var(--color-negative)",
};

function cellColors(state: SignalState): React.CSSProperties {
  switch (state) {
    case "LONG":
      return { background: "var(--color-positive)", color: "#04220c", border: "1px solid transparent" };
    case "SHORT":
      return { background: "var(--color-negative)", color: "#2a0606", border: "1px solid transparent" };
    case "NEUTRAL":
      return { background: "#4a4a4a", color: "#c9c9c9", border: "1px solid transparent" };
    case "NO_COVERAGE":
      return { background: "transparent", color: "var(--text-muted)", border: "1px dashed #5a5a5a" };
  }
}

/** Diverging heat for the gap column only (the decision column). */
function gapHeat(gap: number | null): React.CSSProperties {
  if (gap === null) return { color: "var(--text-muted)" };
  const a = Math.min(Math.abs(gap) / 3, 1) * 0.55;
  return {
    background: gap >= 0 ? `rgba(24, 160, 88, ${a})` : `rgba(220, 68, 68, ${a})`,
    color: "var(--text-primary)",
    fontWeight: 700,
  };
}

function fmtSigned(v: number | null, digits: number): string {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
}

function erLabel(nextEr: { date: string; days: number } | null): { text: string; dim: boolean } {
  if (!nextEr) return { text: "—", dim: true };
  const d = new Date(`${nextEr.date}T00:00:00Z`);
  const label = `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · ${nextEr.days}D`;
  return { text: label, dim: nextEr.days > 30 };
}

function StackCell({
  chip,
  state,
  hover,
  onClick,
  overlay,
}: {
  chip: string;
  state: SignalState;
  hover: string;
  onClick: () => void;
  overlay?: "trap" | "crowded" | null;
}) {
  return (
    <button
      type="button"
      title={hover}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        position: "relative",
        width: 26,
        height: 18,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.4,
        cursor: "pointer",
        borderRadius: 0,
        ...cellColors(state),
      }}
    >
      {chip}
      {overlay === "trap" && (
        <span
          style={{ position: "absolute", top: -4, right: -3, fontSize: 8, color: "var(--color-negative)", fontWeight: 700 }}
        >
          !
        </span>
      )}
      {overlay === "crowded" && (
        <span
          style={{ position: "absolute", top: -3, right: -3, width: 5, height: 5, borderRadius: 3, background: "var(--color-warning, #ffb000)" }}
        />
      )}
    </button>
  );
}

const th: React.CSSProperties = {
  padding: "3px 8px",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  textAlign: "left",
  whiteSpace: "nowrap",
  borderBottom: "1px solid var(--chrome-border)",
};
const td: React.CSSProperties = {
  padding: "3px 8px",
  fontSize: 11,
  whiteSpace: "nowrap",
  borderBottom: "1px solid var(--bg-border)",
  verticalAlign: "middle",
};

export function ConfluenceTable({
  rows,
  asOf,
  showWeight,
}: {
  rows: ConfluenceRowDto[];
  asOf: ConfluencePayload["asOf"];
  showWeight: boolean;
}) {
  const router = useRouter();
  const [shown, setShown] = useState(PAGE);
  const visible = useMemo(() => rows.slice(0, shown), [rows, shown]);

  if (rows.length === 0) {
    return (
      <div style={{ padding: 20, fontSize: 12, color: "var(--text-muted)" }}>
        No names match the current filters — clear the funnel segment or side filter, or wait for the
        weekly snapshots to accrue.
      </div>
    );
  }

  const go = (href: string) => router.push(href);

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={th}>
              <ConfluenceMetricTip id="stackDepth">RANK</ConfluenceMetricTip>
            </th>
            <th style={th}>COMPANY</th>
            <th style={th}>TICKER</th>
            <th style={th}>
              <ConfluenceMetricTip id="noCoverage">F · R · 13F</ConfluenceMetricTip>
            </th>
            <th style={th}>STAGE</th>
            <th style={th}>
              <ConfluenceMetricTip id="fundDecile">FUND DEC</ConfluenceMetricTip>
            </th>
            <th style={th}>
              <ConfluenceMetricTip id="revGap">REV GAP</ConfluenceMetricTip>
            </th>
            <th style={th}>
              <ConfluenceMetricTip id="flowBps">FLOW BPS</ConfluenceMetricTip>
            </th>
            <th style={th}>
              <ConfluenceMetricTip id="idioShare">IDIO %</ConfluenceMetricTip>
            </th>
            <th style={{ ...th, minWidth: 320 }}>
              <ConfluenceMetricTip id="readSentence">READ</ConfluenceMetricTip>
            </th>
            <th style={th}>
              <ConfluenceMetricTip id="nextEr">NEXT ER</ConfluenceMetricTip>
            </th>
            {showWeight && (
              <th style={th}>
                <ConfluenceMetricTip id="heldWeight">WGT</ConfluenceMetricTip>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const er = erLabel(r.nextEr);
            const idioPct = r.idioShare !== null ? r.idioShare * 100 : null;
            const idioWarn = idioPct !== null && idioPct < CONFLUENCE_THRESHOLDS.idioWarnPct;
            const chipColor = STAGE_CHIP_COLOR[r.stage];
            return (
              <tr key={r.ticker}>
                <td style={{ ...td, color: "var(--text-muted)" }}>{r.rank}</td>
                <td
                  style={{
                    ...td,
                    color: "var(--text-secondary)",
                    maxWidth: 160,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={r.companyName ?? undefined}
                >
                  {r.companyName ?? "—"}
                </td>
                <td style={td}>
                  <button
                    type="button"
                    onClick={() => go(`/research?tab=trajectory&ticker=${r.ticker}`)}
                    title={r.companyName ?? r.ticker}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      color: "var(--color-accent)",
                      fontWeight: 700,
                      fontSize: 11,
                      font: "inherit",
                    }}
                  >
                    {r.ticker}
                  </button>
                  {r.direction && (
                    <span
                      style={{
                        marginLeft: 5,
                        fontSize: 9,
                        fontWeight: 700,
                        color: r.direction === "LONG" ? "var(--color-positive)" : "var(--color-negative)",
                      }}
                    >
                      {r.direction === "LONG" ? "L" : "S"}
                    </span>
                  )}
                </td>
                <td style={td}>
                  <span style={{ display: "inline-flex", gap: 3 }}>
                    <StackCell
                      chip="F"
                      state={r.f}
                      overlay={r.trapFlag ? "trap" : null}
                      hover={`FUNDAMENTALS ${r.f}${r.decile !== null ? ` · D${r.decile} (${r.decileBasis?.toLowerCase()})` : ""}${r.trapFlag ? " · TRAP" : ""}${r.flags.length ? ` · ${r.flags.join(", ")}` : ""} · as of ${asOf.fundamentalsSnapshotDate ?? "—"}`}
                      onClick={() => go(`/fundamentals?tab=diligence&ticker=${r.ticker}`)}
                    />
                    <StackCell
                      chip="R"
                      state={r.r}
                      hover={`REVISIONS ${r.r}${r.gapScore !== null ? ` · GAP ${fmtSigned(r.gapScore, 1)}σ` : ""}${r.streakLen ? ` · ${r.streakLen}W ${Number(r.streakSign) < 0 ? "NEG" : "POS"} STREAK` : ""} · as of ${asOf.revisionSnapshotDate ?? "—"}`}
                      onClick={() => go(`/research?tab=trajectory&ticker=${r.ticker}`)}
                    />
                    <StackCell
                      chip="13F"
                      state={r.f13}
                      overlay={r.crowded ? "crowded" : null}
                      hover={`13F FLOWS ${r.f13}${r.netflowBps !== null ? ` · ${fmtSigned(r.netflowBps, 1)}bps` : ""}${r.lifecycleStage ? ` · ${r.lifecycleStage}` : ""}${r.inExitCluster ? " · EXIT CLUSTER" : ""}${r.crowded ? " · CROWDED (breadth ≥ p75)" : ""} · quarter-end ${asOf.flowPeriod ?? "—"}`}
                      onClick={() => go(`/flows?tab=trajectories&ticker=${r.ticker}`)}
                    />
                  </span>
                </td>
                <td style={td}>
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: 0.4,
                      color: chipColor,
                      border: `1px solid ${chipColor}`,
                      padding: "0 4px",
                    }}
                  >
                    {stageChipLabel(r.stage, r.singleSource)}
                    {r.stage === "CONFLICT" && r.direction && (
                      <span style={{ marginLeft: 3 }}>{r.direction === "LONG" ? "▲" : "▼"}</span>
                    )}
                  </span>
                </td>
                <td style={{ ...td, color: "var(--text-secondary)" }}>
                  {r.decile !== null ? `D${r.decile}` : "—"}
                  {r.trapFlag && (
                    <ConfluenceMetricTip id="trapFlag" style={{ marginLeft: 4, color: "var(--color-negative)" }}>
                      TRAP
                    </ConfluenceMetricTip>
                  )}
                </td>
                <td style={{ ...td, ...gapHeat(r.gapScore) }}>{fmtSigned(r.gapScore, 1)}</td>
                <td style={{ ...td, color: "var(--text-secondary)" }}>
                  {fmtSigned(r.netflowBps, 1)}
                  {r.lifecycleStage && (
                    <span style={{ marginLeft: 4, fontSize: 9, color: "var(--text-muted)" }}>{r.lifecycleStage}</span>
                  )}
                </td>
                <td style={{ ...td, color: idioWarn ? "var(--color-warning, #ffb000)" : "var(--text-secondary)" }}>
                  {idioPct !== null ? `${Math.round(idioPct)}%` : "—"}
                </td>
                <td style={{ ...td, fontSize: 10, color: "var(--text-primary)", whiteSpace: "normal", minWidth: 320 }}>
                  {r.read}
                </td>
                <td style={{ ...td, color: er.dim ? "var(--text-muted)" : "#ffd24a" }}>{er.text}</td>
                {showWeight && (
                  <td style={{ ...td, color: "var(--text-secondary)" }}>
                    {r.held ? `${(r.held.weight * 100).toFixed(1)}%${r.held.isShort ? " S" : ""}` : "—"}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > shown && (
        <button
          type="button"
          onClick={() => setShown((s) => s + PAGE)}
          style={{
            margin: "6px 8px",
            background: "transparent",
            border: "1px solid var(--chrome-border)",
            color: "var(--color-accent)",
            fontSize: 10,
            fontWeight: 700,
            padding: "3px 10px",
            cursor: "pointer",
          }}
        >
          SHOW {Math.min(PAGE, rows.length - shown)} MORE ({rows.length - shown} REMAINING)
        </button>
      )}
    </div>
  );
}
