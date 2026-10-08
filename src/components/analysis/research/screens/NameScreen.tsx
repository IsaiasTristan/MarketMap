"use client";
/**
 * Screen 3 — one name, no tabs. The analyst price-target panel is the page's
 * subject; everything to the right of it is context for reading that panel,
 * and the log at the bottom is the raw evidence behind the week's score.
 */
import { useRouter } from "next/navigation";
import { PanelState } from "@/components/analysis/ui/PanelState";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { Tag } from "../primitives";
import { fmtCap } from "@/lib/revision/screen-format";
import { AnalystTargetTimeline } from "./AnalystTargetTimeline";
import { EngineTiles, EventLog, GroupIdioBars, NameStatTiles, PeerStrip, SmallMultiples } from "./NamePanels";
import { useNameScreen } from "./useScreens";

export function NameScreen({ ticker }: { ticker: string }) {
  const router = useRouter();
  const { data, state, error } = useNameScreen(ticker);

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            {/* Filters live in the queue's URL, so plain history-back restores them exactly. */}
            <button
              type="button"
              onClick={() => router.back()}
              style={{
                fontSize: 10,
                color: "var(--color-accent)",
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              ← Back
            </button>
            <span style={{ fontSize: 16, fontWeight: 700 }}>{data.ticker}</span>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{data.companyName ?? ""}</span>
            {data.row && (
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {data.row.subsector} · {data.row.sector} · {fmtCap(data.row.mktCap)} · {data.row.analystCount} analysts
              </span>
            )}
            {data.rank !== null && (
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                queue rank {data.rank} of {data.universeSize}
              </span>
            )}
            {(data.row?.isNewTop || data.row?.isNewBottom) && (
              <Tag label="NEW" tone={data.row?.isNewTop ? "positive" : "negative"} />
            )}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>week of {data.snapshotDate}</span>
          </div>

          <NameStatTiles payload={data} />

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2.4fr) minmax(280px, 1fr)", gap: 6, alignItems: "start" }}>
            <ChartCard
              title="Analyst price targets — one line per analyst, 18 months"
              subtitle="Each line holds an analyst's target until their next event. This is the matched panel the score is computed from."
            >
              <AnalystTargetTimeline
                analysts={data.panel.analysts}
                price={data.panel.price}
                earningsDates={data.panel.earningsDates}
                nextEarnings={data.panel.nextEarnings}
                summary={data.panel.summary}
                staleDays={data.panel.staleDays}
              />
            </ChartCard>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <ChartCard title="Where it sits among its peers">
                <PeerStrip
                  peers={data.peers}
                  ticker={data.ticker}
                  own={data.row?.ptRevOrthZ ?? null}
                  subsector={data.row?.subsector ?? "its industry"}
                />
              </ChartCard>
              <ChartCard title="Industry tide vs company-specific">
                <GroupIdioBars
                  grpZ={data.row?.grpZ ?? null}
                  idioZ={data.row?.idioZ ?? null}
                  subsector={data.row?.subsector ?? "the industry"}
                />
              </ChartCard>
              <ChartCard title="What the other engines say" compact>
                <EngineTiles row={data.row} />
              </ChartCard>
            </div>
          </div>

          <SmallMultiples sm={data.smallMultiples} />

          <ChartCard title="Every price-target event behind the score" compact>
            <EventLog
              events={data.events}
              contribution={data.row?.ptRevOrthRaw ?? null}
              weekStart={data.priorSnapshotDate ?? data.snapshotDate}
              snapshotDate={data.snapshotDate}
            />
          </ChartCard>
        </div>
      )}
    </PanelState>
  );
}
