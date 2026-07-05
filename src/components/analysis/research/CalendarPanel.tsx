"use client";
/**
 * CALENDAR — names reporting in the next ~3 weeks with a live revision signal
 * (|rev z| ≥ threshold) or a queue flag, grouped by week. REV Z IN is the
 * proximity-weighted composite heading into the print (heat); everything else
 * stays flat context.
 */
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { PanelState } from "@/components/analysis/ui/PanelState";
import { useRevision } from "./useRevision";
import { MetricTip } from "./MetricTip";
import { SideChip, StreakStrip, fmtZ, heatZ } from "./researchUi";
import type { RevMetricId } from "@/lib/revision/metric-registry";

interface CalendarRow {
  ticker: string;
  companyName: string;
  erDate: string;
  days: number;
  composite: number | null;
  gapScore: number | null;
  side: string | null;
  streakHistory: Array<-1 | 0 | 1>;
  streakSource: string | null;
  setupLine: string;
}

interface CalendarPayload {
  today: string;
  days: number;
  weeks: Array<{ label: string; rows: CalendarRow[] }>;
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "3px 6px",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 0.5,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "3px 6px",
  fontSize: 11,
  borderTop: "1px solid var(--chrome-border)",
  whiteSpace: "nowrap",
};

function Th({ id, children }: { id: RevMetricId; children: React.ReactNode }) {
  return (
    <th style={th}>
      <MetricTip id={id}>{children}</MetricTip>
    </th>
  );
}

export function CalendarPanel({ onSelectTicker }: { onSelectTicker: (t: string) => void }) {
  const { data, state, error } = useRevision<CalendarPayload>(
    ["research-calendar"],
    "/api/analysis/research/calendar?days=21",
  );

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {data.weeks.length === 0 && (
            <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)" }}>
              NO QUALIFYING PRINTS IN THE NEXT {data.days} DAYS (|REV Z| ≥ 1.0 OR IN QUEUE)
            </div>
          )}
          {data.weeks.map((week) => (
            <ChartCard key={week.label} title={week.label} compact style={{ overflow: "visible" }}>
              <table className="bb-table" style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <Th id="nextEr">ER date</Th>
                    <th style={th}>Days</th>
                    <th style={th}>Ticker</th>
                    <Th id="revZIn">Rev z in</Th>
                    <Th id="gapScore">Gap</Th>
                    <Th id="streak">6w strk</Th>
                    <Th id="side">Side</Th>
                    <Th id="setupIntoPrint">Setup into print</Th>
                  </tr>
                </thead>
                <tbody>
                  {week.rows.map((r) => (
                    <tr key={r.ticker}>
                      <td className="bb-num" style={{ ...td, color: "var(--text-secondary)" }}>{r.erDate}</td>
                      <td className="bb-num" style={{ ...td, color: r.days <= 2 ? "var(--color-accent)" : "var(--text-muted)" }}>
                        {r.days}
                      </td>
                      <td style={td}>
                        <button
                          type="button"
                          onClick={() => onSelectTicker(r.ticker)}
                          style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--color-accent)", fontWeight: 700, font: "inherit" }}
                        >
                          {r.ticker}
                        </button>
                      </td>
                      <td className="bb-num" style={{ ...td, fontWeight: 700, color: heatZ(r.composite, 1.5) }}>
                        {fmtZ(r.composite)}
                      </td>
                      <td className="bb-num" style={{ ...td, color: "var(--text-secondary)" }}>{fmtZ(r.gapScore)}</td>
                      <td style={td}>
                        <StreakStrip history={r.streakHistory} source={r.streakSource} />
                      </td>
                      <td style={td}>
                        <SideChip side={r.side} />
                      </td>
                      <td style={{ ...td, color: "var(--text-secondary)", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {r.setupLine}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ChartCard>
          ))}
        </div>
      )}
    </PanelState>
  );
}
