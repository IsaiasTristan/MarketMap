"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BloombergTabStrip, type BloombergTabItem } from "@/components/analysis/BloombergTabStrip";
import { DrilldownMenu } from "./DrilldownMenu";
import { SummaryPanel } from "./SummaryPanel";
import { IdeaQueuePanel } from "./IdeaQueuePanel";
import { ValidationPanel } from "./ValidationPanel";
import { CalendarPanel } from "./CalendarPanel";
import { DecompPanel } from "./DecompPanel";
import { RevisionTrajectory } from "./RevisionTrajectory";
import { RotationFlow } from "./RotationFlow";
import { BreadthHeatmap } from "./BreadthHeatmap";
import { RatingChanges } from "./RatingChanges";

type ResearchTab =
  | "summary"
  | "queue"
  | "events"
  | "validation"
  | "calendar"
  | "decomp"
  | "trajectory"
  | "rotation"
  | "heatmap";

const PRIMARY_TABS: BloombergTabItem[] = [
  { key: "summary", label: "Summary" },
  { key: "queue", label: "Idea Queue" },
  { key: "events", label: "Rating Changes" },
  { key: "validation", label: "Validation" },
  { key: "calendar", label: "Calendar" },
  { key: "decomp", label: "Decomp" },
];

const DRILLDOWNS = [
  { key: "trajectory", label: "Revision Trajectory" },
  { key: "rotation", label: "Rotation Flow" },
  { key: "heatmap", label: "Breadth Heatmap" },
];

const ALL_TABS = new Set<ResearchTab>([
  "summary",
  "queue",
  "events",
  "validation",
  "calendar",
  "decomp",
  "trajectory",
  "rotation",
  "heatmap",
]);

export function ResearchClient() {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<ResearchTab>("summary");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [queueFocus, setQueueFocus] = useState<string | null>(null);
  const [eventsFocus, setEventsFocus] = useState<string | null>(null);
  const [rotationFocus, setRotationFocus] = useState<{ groupType: "SECTOR" | "SUBSECTOR"; groupKey: string } | null>(
    null,
  );

  // Deep-link contract: /research?tab=&ticker=&group=&groupType= (see GotoLink).
  useEffect(() => {
    const tabParam = searchParams.get("tab") as ResearchTab | null;
    const ticker = searchParams.get("ticker");
    const group = searchParams.get("group");
    const groupType = searchParams.get("groupType") === "SECTOR" ? "SECTOR" : "SUBSECTOR";
    if (!tabParam || !ALL_TABS.has(tabParam)) return;
    if (ticker) {
      if (tabParam === "trajectory") setSelectedTicker(ticker.toUpperCase());
      if (tabParam === "queue") setQueueFocus(ticker.toUpperCase());
      if (tabParam === "events") setEventsFocus(ticker.toUpperCase());
    }
    if (group && (tabParam === "rotation" || tabParam === "decomp")) {
      setRotationFocus({ groupType, groupKey: group });
    }
    setTab(tabParam);
  }, [searchParams]);

  const openTrajectory = (ticker: string) => {
    setSelectedTicker(ticker);
    setTab("trajectory");
  };
  const openQueue = (ticker?: string) => {
    setQueueFocus(ticker ?? null);
    setTab("queue");
  };
  const openRotation = (groupType: "SECTOR" | "SUBSECTOR", groupKey: string) => {
    setRotationFocus({ groupType, groupKey });
    setTab("rotation");
  };

  const drilldownKey = DRILLDOWNS.some((d) => d.key === tab) ? tab : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4, color: "var(--text-primary)" }}>
          ANALYST REVISION DETECTOR
        </div>
        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
          Engine 1 — where analysts are changing their minds, before price reflects it. Decision queue, not a trader.
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "stretch" }}>
        <div style={{ flex: 1 }}>
          <BloombergTabStrip
            tabs={PRIMARY_TABS}
            activeKey={drilldownKey ? "" : tab}
            onChange={(k) => setTab(k as ResearchTab)}
          />
        </div>
        <DrilldownMenu items={DRILLDOWNS} activeKey={drilldownKey} onSelect={(k) => setTab(k as ResearchTab)} />
      </div>

      <div>
        {tab === "summary" && (
          <SummaryPanel onSelectTicker={openTrajectory} onOpenQueue={openQueue} onOpenRotation={openRotation} />
        )}
        {tab === "queue" && <IdeaQueuePanel focusTicker={queueFocus} onSelectTicker={openTrajectory} />}
        {tab === "events" && <RatingChanges ticker={eventsFocus} onSelectTicker={openTrajectory} onOpenQueue={openQueue} />}
        {tab === "validation" && <ValidationPanel />}
        {tab === "calendar" && <CalendarPanel onSelectTicker={openTrajectory} />}
        {tab === "decomp" && <DecompPanel onOpenRotation={openRotation} onSelectTicker={openTrajectory} />}
        {tab === "trajectory" && (
          <RevisionTrajectory ticker={selectedTicker} onPickTicker={setSelectedTicker} />
        )}
        {tab === "rotation" && (
          <RotationFlow initialGroupType={rotationFocus?.groupType} focusGroup={rotationFocus?.groupKey ?? null} />
        )}
        {tab === "heatmap" && <BreadthHeatmap />}
      </div>
    </div>
  );
}
