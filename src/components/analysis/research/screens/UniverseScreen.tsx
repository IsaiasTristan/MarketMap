"use client";
/**
 * Screen 1 — the universe. Where are analysts changing their minds this week,
 * and has price already reacted? Every panel is a way into the queue or into
 * a name, so this is the top of the funnel rather than a dashboard.
 */
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { PanelState } from "@/components/analysis/ui/PanelState";
import {
  BreadthTiles,
  ChurnPanel,
  CompositionPanel,
  DensityOverlay,
  RevPriceScatter,
  SubsectorHeatmap,
} from "./UniversePanels";
import { useUniverseScreen } from "./useScreens";

export function UniverseScreen() {
  const { data, state, error } = useUniverseScreen();

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <BreadthTiles strip={data.strip} />

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr)", gap: 6, alignItems: "start" }}>
            <ChartCard title="Spread of revision scores">
              <DensityOverlay histogram={data.histogram} />
            </ChartCard>
            <ChartCard title="Who joined and left the strongest 10% this week">
              <ChurnPanel churn={data.churn} />
            </ChartCard>
          </div>

          <ChartCard
            title="Which industries are analysts upgrading"
            subtitle="Green = analysts raising targets across the industry, red = cutting. The arrow is the four-week change. Click an industry to open the queue filtered to it."
          >
            <SubsectorHeatmap cells={data.subsectors} />
          </ChartCard>

          <ChartCard
            title="Have prices caught up"
            subtitle="Bottom-right is the setup this engine exists to find: analysts raising targets while the stock has not outrun its peers."
          >
            <RevPriceScatter rows={data.scatter} />
          </ChartCard>

          <ChartCard
            title="Is the screen finding under-followed stocks"
            subtitle="How the strongest decile splits by company size and analyst coverage, against the universe it was drawn from."
          >
            <CompositionPanel composition={data.composition} />
          </ChartCard>
        </div>
      )}
    </PanelState>
  );
}
