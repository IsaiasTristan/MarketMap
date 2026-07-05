"use client";
/**
 * SUMMARY — the default landing tab. Delta-oriented triage: ONLY transitions
 * since the previous snapshot (SignalTransition rows), grouped into NEW IDEAS /
 * EXITS & DEGRADING / CATALYSTS ≤7D / GROUP TRIGGERS, plus a header stat strip
 * and an IC health warning. An empty feed is a valid, fast outcome.
 */
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { PanelState } from "@/components/analysis/ui/PanelState";
import { useRevision } from "./useRevision";
import { GotoLink } from "./GotoLink";
import { StatStrip, TagChip, fmtZ } from "./researchUi";

interface SummaryRow {
  type: string;
  ticker: string | null;
  companyName: string | null;
  groupType: "SECTOR" | "SUBSECTOR" | null;
  groupKey: string | null;
  reason: string;
  gapScore: number | null;
  snapshotDate: string;
}

interface SummaryPayload {
  snapshotDate: string;
  prevDate: string | null;
  stats: {
    icCurrent: number | null;
    icLongRun: number | null;
    icSource: "FULL" | "LEG_B" | null;
    icWarning: boolean;
    breadth: number | null;
    actionable: { n: number; longs: number; shorts: number };
    newCount: number;
    exitCount: number;
    legADepthWeeks: number;
  };
  groups: {
    newIdeas: SummaryRow[];
    exits: SummaryRow[];
    catalysts: SummaryRow[];
    groupTriggers: SummaryRow[];
  };
}

const TYPE_TAG: Record<string, string> = {
  NEW_LONG: "LONG",
  NEW_SHORT: "SHORT",
  GAP_CLOSED: "GAP CLOSED",
  STREAK_BROKEN: "STRK BREAK",
  ER_WITHIN_7D: "ER",
  GROUP_INFLECTION: "INFLECT",
  GROUP_ROLLOVER: "ROLLOVER",
  NEXT_DOMINO: "DOMINO",
};

const TYPE_COLOR: Record<string, string> = {
  NEW_LONG: "var(--color-positive)",
  NEW_SHORT: "var(--color-negative)",
  GAP_CLOSED: "var(--text-muted)",
  STREAK_BROKEN: "var(--color-warning)",
  ER_WITHIN_7D: "#ffd24a",
  GROUP_INFLECTION: "var(--color-positive)",
  GROUP_ROLLOVER: "var(--color-negative)",
  NEXT_DOMINO: "#5aa0ff",
};

function TransitionRow({
  row,
  onSelectTicker,
  onOpenRotation,
}: {
  row: SummaryRow;
  onSelectTicker: (t: string) => void;
  onOpenRotation: (groupType: "SECTOR" | "SUBSECTOR", key: string) => void;
}) {
  const tag = TYPE_TAG[row.type] ?? row.type;
  const color = TYPE_COLOR[row.type] ?? "var(--text-muted)";
  const isGroupRow = !row.ticker && row.groupKey;
  const gotoTab =
    row.type === "ER_WITHIN_7D" ? "calendar" : row.type.startsWith("GROUP") ? "rotation" : "queue";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 7,
        padding: "4px 8px",
        borderTop: "1px solid var(--chrome-border)",
        fontSize: 11,
      }}
    >
      <span
        style={{
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: 0.5,
          color,
          border: `1px solid ${color}`,
          padding: "0 3px",
          lineHeight: "12px",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {tag}
      </span>
      {row.ticker ? (
        <button
          type="button"
          onClick={() => onSelectTicker(row.ticker!)}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: "var(--color-accent)",
            fontWeight: 700,
            font: "inherit",
            flexShrink: 0,
          }}
        >
          {row.ticker}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => row.groupKey && onOpenRotation(row.groupType ?? "SUBSECTOR", row.groupKey)}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: "var(--color-accent)",
            fontWeight: 700,
            font: "inherit",
            flexShrink: 0,
            textTransform: "uppercase",
          }}
        >
          {row.groupKey}
        </button>
      )}
      <span style={{ color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
        {row.reason}
      </span>
      <GotoLink
        tab={gotoTab}
        ticker={row.ticker}
        group={isGroupRow ? row.groupKey : undefined}
        groupType={isGroupRow ? row.groupType : undefined}
      >
        GOTO →
      </GotoLink>
    </div>
  );
}

function FeedCard({
  title,
  subtitle,
  rows,
  emptyLabel,
  onSelectTicker,
  onOpenRotation,
}: {
  title: string;
  subtitle: string;
  rows: SummaryRow[];
  emptyLabel: string;
  onSelectTicker: (t: string) => void;
  onOpenRotation: (groupType: "SECTOR" | "SUBSECTOR", key: string) => void;
}) {
  return (
    <ChartCard title={title} subtitle={subtitle} compact style={{ overflow: "visible" }}>
      {rows.length === 0 ? (
        <div style={{ padding: "10px 8px", fontSize: 10, letterSpacing: 0.5, color: "var(--text-muted)" }}>{emptyLabel}</div>
      ) : (
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          {rows.map((r, i) => (
            <TransitionRow key={`${r.type}-${r.ticker ?? r.groupKey}-${i}`} row={r} onSelectTicker={onSelectTicker} onOpenRotation={onOpenRotation} />
          ))}
        </div>
      )}
    </ChartCard>
  );
}

export function SummaryPanel({
  onSelectTicker,
  onOpenQueue,
  onOpenRotation,
}: {
  onSelectTicker: (t: string) => void;
  onOpenQueue: (t?: string) => void;
  onOpenRotation: (groupType: "SECTOR" | "SUBSECTOR", key: string) => void;
}) {
  const { data, state, error } = useRevision<SummaryPayload>(["research-summary"], "/api/analysis/research/summary");

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <StatStrip
            items={[
              {
                metricId: "signalIc",
                label: `Signal IC${data.stats.icSource === "LEG_B" ? " (Lᴮ)" : ""}`,
                value: data.stats.icCurrent !== null ? fmtZ(data.stats.icCurrent, 3) : "—",
                delta: data.stats.icLongRun !== null ? fmtZ(data.stats.icLongRun, 3) : undefined,
                deltaDir:
                  data.stats.icCurrent !== null && data.stats.icLongRun !== null && data.stats.icCurrent >= data.stats.icLongRun
                    ? "up"
                    : "down",
                sub: "vs 26w avg",
                tone: data.stats.icWarning ? "negative" : undefined,
              },
              {
                metricId: "mktBreadth",
                label: "Mkt breadth",
                value: data.stats.breadth !== null ? fmtZ(data.stats.breadth, 2) : "—",
                tone: (data.stats.breadth ?? 0) < 0 ? "negative" : "positive",
              },
              {
                metricId: "actionable",
                label: "Actionable",
                value: (
                  <button
                    type="button"
                    onClick={() => onOpenQueue()}
                    style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "inherit", font: "inherit" }}
                  >
                    {data.stats.actionable.n}
                  </button>
                ),
                sub: `${data.stats.actionable.longs}L / ${data.stats.actionable.shorts}S`,
              },
              { metricId: "newCount", label: "New", value: data.stats.newCount, tone: data.stats.newCount > 0 ? "positive" : undefined },
              { metricId: "exitCount", label: "Exits", value: data.stats.exitCount, tone: data.stats.exitCount > 0 ? "warning" : undefined },
            ]}
          />

          {data.stats.icWarning && (
            <div
              style={{
                border: "1px solid var(--color-negative)",
                color: "var(--color-negative)",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.5,
                padding: "5px 10px",
              }}
            >
              ⚠ ROLLING IC ≤ 0 — THE COMPOSITE IS NOT CURRENTLY PREDICTING RETURNS. TREAT EVERYTHING BELOW AS A WATCHLIST, NOT A SIGNAL.
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 8 }}>
            <FeedCard
              title="New ideas"
              subtitle={`Entered the long/short set at the ${data.snapshotDate} scoring pass`}
              rows={data.groups.newIdeas}
              emptyLabel={`NO TRANSITIONS SINCE ${data.prevDate ?? "—"}`}
              onSelectTicker={onSelectTicker}
              onOpenRotation={onOpenRotation}
            />
            <FeedCard
              title="Exits & degrading"
              subtitle="Gaps that closed · streaks that broke"
              rows={data.groups.exits}
              emptyLabel={`NO TRANSITIONS SINCE ${data.prevDate ?? "—"}`}
              onSelectTicker={onSelectTicker}
              onOpenRotation={onOpenRotation}
            />
            <FeedCard
              title="Catalysts ≤7D"
              subtitle="Reports inside the window with a live revision signal"
              rows={data.groups.catalysts}
              emptyLabel="NO PRINTS IN WINDOW"
              onSelectTicker={onSelectTicker}
              onOpenRotation={onOpenRotation}
            />
            <FeedCard
              title="Group triggers"
              subtitle="Sector/subsector inflections, rollovers, next dominos"
              rows={data.groups.groupTriggers}
              emptyLabel={`NO TRANSITIONS SINCE ${data.prevDate ?? "—"}`}
              onSelectTicker={onSelectTicker}
              onOpenRotation={onOpenRotation}
            />
          </div>

          <div style={{ display: "inline-flex", gap: 6, alignItems: "baseline" }}>
            <TagChip tag="UNPR" />
            <TagChip tag="STRK" />
            <TagChip tag="ER" />
            <TagChip tag="DOMINO" />
            <span style={{ fontSize: 9, color: "var(--text-muted)" }}>
              setup tags (hover for definitions) · Leg A depth {data.stats.legADepthWeeks}w — analytics deepen automatically as history accrues
            </span>
          </div>
        </div>
      )}
    </PanelState>
  );
}
