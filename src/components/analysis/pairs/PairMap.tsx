"use client";
/**
 * Pair Map screen — the discovery surface on the mockup's skeleton: a controls
 * strip, then a row of the pair matrix (with SECTOR + SIGNAL controls along its
 * bottom, per the mockup), the divergence 2×2 and the dispersion map, then the
 * full-width ranked table, then a row of arrivals/departures, the Tier-2 spread
 * and the Tier-3 read-through. Heights are content-driven so no panel shows a
 * dead band. Every panel reads the same week's PairSnapshot / PairGroupSnapshot
 * rows and uses the shared ChartCard / PanelState chrome.
 */
import { useEffect, useState } from "react";
import { usePairUniverse, usePairMatrix, usePairRank, usePairDispersion, usePairTier2, type PairWeighting, type PairScope } from "./usePairs";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { PanelState } from "@/components/analysis/ui/PanelState";
import { PairRankTable } from "./PairRankTable";
import { PairMatrix, pairMatrixSectors, type MatrixEngine } from "./PairMatrix";
import { DivergenceScatter } from "./DivergenceScatter";
import { DispersionMap } from "./DispersionMap";
import { Tier2Panel } from "./Tier2Panel";
import { Tier3Panel } from "./Tier3Panel";
import { pairCode } from "@/lib/pairs/labels";

const ROW1 = 360; // charts row — SVGs need an explicit height
const CHART_H = ROW1 - 20 - 26; // panel header + footer strip

function Toggle<T extends string>({ label, options, value, onChange }: { label: string; options: { v: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ fontSize: 8.5, letterSpacing: 0.5, color: "var(--text-muted)", textTransform: "uppercase", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ display: "inline-flex", border: "1px solid var(--chrome-border)" }}>
        {options.map((o) => (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              padding: "2px 8px",
              border: "none",
              cursor: "pointer",
              color: value === o.v ? "#000" : "var(--text-muted)",
              background: value === o.v ? "var(--color-accent)" : "var(--bg-surface)",
            }}
          >
            {o.label}
          </button>
        ))}
      </span>
    </span>
  );
}

/** A row of small selectable chips, mockup-style (SECTOR / SIGNAL rows). */
function ChipControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { v: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span style={{ fontSize: 8.5, letterSpacing: 0.6, color: "var(--text-muted)", textTransform: "uppercase", minWidth: 46 }}>{label}</span>
      <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 3 }}>
        {options.map((o) => {
          const active = o.v === value;
          return (
            <button
              key={o.v}
              onClick={() => onChange(o.v)}
              style={{
                fontSize: 8.5,
                fontWeight: 700,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                padding: "1px 6px",
                cursor: "pointer",
                whiteSpace: "nowrap",
                color: active ? "#000" : "var(--text-secondary)",
                background: active ? "var(--color-accent)" : "var(--bg-base)",
                border: `1px solid ${active ? "var(--color-accent)" : "var(--chrome-border)"}`,
              }}
            >
              {o.label}
            </button>
          );
        })}
      </span>
    </div>
  );
}

function Chips({ title, items, tone }: { title: string; items: string[]; tone: "positive" | "negative" }) {
  const color = tone === "positive" ? "var(--color-positive)" : "var(--color-negative)";
  const CAP = 12;
  const shown = items.slice(0, CAP);
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 9, letterSpacing: 0.5, color, textTransform: "uppercase", fontWeight: 700, marginBottom: 3 }}>
        {title} ({items.length})
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        {items.length === 0 ? (
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>none</span>
        ) : (
          shown.map((k) => {
            const [long, short] = k.includes("|") ? k.slice(k.indexOf(":") + 1).split("|") : [k, ""];
            const label = short ? pairCode(long, short) : long;
            return (
              <span key={k} title={short ? `${long} ▸ ${short}` : long} style={{ fontSize: 9, fontWeight: 700, color, border: `1px solid ${color}`, padding: "0 4px", whiteSpace: "nowrap" }}>
                {label}
              </span>
            );
          })
        )}
      </div>
      {items.length > CAP ? (
        <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 3 }}>+{items.length - CAP} more</div>
      ) : null}
    </div>
  );
}

export function PairMap() {
  const [weighting, setWeighting] = useState<PairWeighting>("EQUAL");
  const [scope, setScope] = useState<PairScope>("within");
  const [driver, setDriver] = useState<"" | "E1" | "E2" | "BOTH">("");
  const [onlyHedgeable, setOnlyHedgeable] = useState(true);
  const [hideThinGaps, setHideThinGaps] = useState(true);
  const [selectedSubsector, setSelectedSubsector] = useState<string | null>(null);
  const [matrixSector, setMatrixSector] = useState<string>("");
  const [crossSectorMatrix, setCrossSectorMatrix] = useState(false);
  const [matrixEngine, setMatrixEngine] = useState<MatrixEngine>("E1");

  const universe = usePairUniverse(weighting);
  const matrix = usePairMatrix(weighting, undefined, crossSectorMatrix ? "SECTOR" : "SUBSECTOR");
  const dispersion = usePairDispersion(weighting);
  const tier2 = usePairTier2(selectedSubsector, weighting);
  const rank = usePairRank({
    weighting,
    scope,
    driver: driver || undefined,
    minHedgeEff: onlyHedgeable ? PAIR_THRESHOLDS.minHedgeEff : undefined,
    limit: 300,
  });

  const sectors = matrix.data ? pairMatrixSectors(matrix.data) : [];
  // The SECTOR-grouped (cross) payload has one row per sector, so pairMatrixSectors
  // returns nothing in cross mode. Persist the last subsector-mode list so the
  // sector chips (and the way back out of cross mode) never disappear.
  const [sectorMenu, setSectorMenu] = useState<string[]>([]);
  useEffect(() => {
    if (!crossSectorMatrix && sectors.length) {
      setSectorMenu((prev) => (prev.join("|") === sectors.join("|") ? prev : sectors));
    }
  }, [crossSectorMatrix, sectors]);
  const menuSectors = sectorMenu.length ? sectorMenu : sectors;
  const effectiveSector = crossSectorMatrix
    ? "__ALL__"
    : menuSectors.includes(matrixSector)
      ? matrixSector
      : menuSectors[0] ?? "";

  if (universe.state === "empty" && matrix.state === "empty") {
    return (
      <div style={{ fontSize: 12, color: "var(--text-muted)", padding: 24, border: "1px solid var(--chrome-border)" }}>
        No pair snapshots yet. Run <code>npm run job:pairs-backfill</code> to populate the 143-week grid.
      </div>
    );
  }

  const sectorOptions = [
    ...menuSectors.map((s) => ({ v: s, label: s })),
    { v: "__CROSS__", label: "Sector × Sector" },
  ];
  const sectorValue = crossSectorMatrix ? "__CROSS__" : effectiveSector;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Controls strip */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, padding: "4px 10px", border: "1px solid var(--chrome-border)", background: "var(--bg-surface)" }}>
        <Toggle label="Basket weighting" options={[{ v: "EQUAL", label: "Equal-wt" }, { v: "CAP", label: "Cap-wt" }]} value={weighting} onChange={setWeighting} />
        <Toggle label="Scope" options={[{ v: "within", label: "Within-sector" }, { v: "cross", label: "Cross" }, { v: "all", label: "All" }]} value={scope} onChange={setScope} />
        <Toggle label="Engine" options={[{ v: "", label: "Any" }, { v: "E1", label: "E1" }, { v: "E2", label: "E2" }, { v: "BOTH", label: "Both" }]} value={driver} onChange={setDriver} />
        <label style={{ fontSize: 9, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={onlyHedgeable} onChange={(e) => setOnlyHedgeable(e.target.checked)} />
          hedge-eff ≥ {PAIR_THRESHOLDS.minHedgeEff}
        </label>
        <label style={{ fontSize: 9, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }} title="One control governs both the divergence scatter and the rank table below.">
          <input type="checkbox" checked={hideThinGaps} onChange={(e) => setHideThinGaps(e.target.checked)} />
          hide thin gaps
        </label>
      </div>

      {/* Row 1 — charts */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr) minmax(0, 1fr)", gap: 6, height: ROW1 }}>
        <ChartCard
          title="Pair matrix"
          subtitle="Each cell = the long row's breadth minus the short column's, in pp (counts for 13F). An arrow marks a 4-week move past the threshold; the tinted diagonal is each subsector's own breadth."
          fillHeight
        >
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: 4 }}>
            <div style={{ flex: 1, minHeight: 0 }}>
              <PanelState state={matrix.state}>{matrix.data ? <PairMatrix data={matrix.data} sector={effectiveSector} engine={matrixEngine} /> : null}</PanelState>
            </div>
            {/* Bottom SECTOR / SIGNAL controls (mockup snip 6). */}
            <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "4px 2px 0", borderTop: "1px solid var(--chrome-border)" }}>
              <ChipControl
                label="Sector"
                options={sectorOptions}
                value={sectorValue}
                onChange={(v) => {
                  if (v === "__CROSS__") setCrossSectorMatrix(true);
                  else {
                    setCrossSectorMatrix(false);
                    setMatrixSector(v);
                  }
                }}
              />
              <ChipControl
                label="Signal"
                options={[
                  { v: "E1", label: "Analyst revisions" },
                  { v: "E2", label: "Business inflection" },
                  { v: "E3", label: "13F fund flows" },
                ]}
                value={matrixEngine}
                onChange={setMatrixEngine}
              />
            </div>
          </div>
        </ChartCard>
        <ChartCard title="Have share prices caught up with the signals?" subtitle="One dot = one pair. Bottom-right is the research zone: the signal has widened but the price ratio has not moved." fillHeight>
          <PanelState state={matrix.state}>{matrix.data ? <DivergenceScatter pairs={matrix.data.pairs} height={CHART_H} hideThinGaps={hideThinGaps} /> : null}</PanelState>
        </ChartCard>
        <ChartCard title="Dispersion map — basket trade or stock picking?" subtitle="One dot = subsector. Click a bubble for its Tier 2 single-stock pair." fillHeight>
          <PanelState state={dispersion.state}>{dispersion.data ? <DispersionMap data={dispersion.data} selected={selectedSubsector} onSelect={setSelectedSubsector} height={CHART_H} /> : null}</PanelState>
        </ChartCard>
      </div>

      {/* Row 2 — ranked pairs */}
      <ChartCard title="Pair rank — sorted by how much the analyst-revision gap changed in 4 weeks" compact>
        <PanelState state={rank.state}>{rank.data ? <PairRankTable rows={rank.data.pairs} snapshotDate={rank.data.snapshotDate} hideThinGaps={hideThinGaps} totalPairs={universe.data?.pairCount} passHedgeEff={universe.data?.passHedgeEff} scopeLabel={scope === "within" ? "within-sector" : scope === "cross" ? "cross-sector" : "all scopes"} /> : null}</PanelState>
      </ChartCard>

      {/* Row 3 — arrivals / Tier 2 / Tier 3 */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.8fr) minmax(0, 1.35fr) minmax(0, 1fr)", gap: 6, alignItems: "start" }}>
        <ChartCard title="Who joined and left this week" subtitle="Pairs that joined or left the strongest signal-gap decile this week (top 10% by signal divergence).">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Chips title="Joined the top 10%" items={universe.data?.arrivals ?? []} tone="positive" />
            <Chips title="Left the top 10%" items={universe.data?.exits ?? []} tone="negative" />
          </div>
        </ChartCard>
        <ChartCard
          title={selectedSubsector ? `Tier 2 — stock pair inside ${selectedSubsector}` : "Tier 2 — stock pair inside a subsector"}
          subtitle="Top-k long vs bottom-k short within one subsector. Short side is basket-scoped — single-name short interest / ADV / borrow are unavailable (Phase-0 probe)."
        >
          <Tier2Panel subsector={selectedSubsector} data={tier2.data ?? null} state={tier2.state} />
        </ChartCard>
        <Tier3Panel />
      </div>
    </div>
  );
}
