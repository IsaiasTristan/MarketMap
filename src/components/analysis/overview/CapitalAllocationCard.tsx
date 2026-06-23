"use client";

import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { Donut, type DonutSlice } from "@/components/analysis/ui/Donut";
import {
  fmtCompact$,
  fmtPctSigned,
  POSITIVE_HEX,
  NEGATIVE_HEX,
} from "@/components/analysis/overview/formatters";
import { BB_GRID_FONT_STACK } from "@/components/analysis/factors/shared/bloomberg-grid";

export type AllocView = "byPosition" | "byReturn" | "byRisk" | "bySector";
export type AllocHorizon = "1D" | "5D" | "1M" | "6M" | "1Y" | "2Y" | "5Y";

type AllocSlice = { name: string; value: number; pct: number };

type ReturnRiskAlloc = {
  horizon: AllocHorizon;
  byReturn: {
    name: string;
    value: number;
    signed: number;
    negative: boolean;
    marketValue: number;
  }[];
  byRisk: {
    name: string;
    value: number;
    pct: number;
    dollar: number;
    negative: false;
    marketValue: number;
  }[];
  totals: {
    returnPct: number;
    returnDollar: number;
    varDollar: number;
    varPct: number;
    grossValue: number;
  };
};

const ALLOC_VIEWS: { id: AllocView; label: string }[] = [
  { id: "byPosition", label: "Position" },
  { id: "byReturn", label: "Return" },
  { id: "byRisk", label: "Risk" },
  { id: "bySector", label: "Sector" },
];

const HORIZON_OPTIONS: AllocHorizon[] = ["1D", "5D", "1M", "6M", "1Y", "2Y", "5Y"];

const btnBase: React.CSSProperties = {
  padding: "1px 6px",
  borderRadius: 0,
  border: "1px solid var(--chrome-border)",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
  lineHeight: 1.25,
  fontFamily: BB_GRID_FONT_STACK,
};

const btnGhost: React.CSSProperties = {
  ...btnBase,
  background: "var(--bg-base)",
  color: "var(--text-secondary)",
};

const btnActive: React.CSSProperties = {
  ...btnBase,
  background: "var(--color-accent)",
  color: "#000",
  borderColor: "var(--color-accent)",
};

interface CapitalAllocationCardProps {
  totalValue: number;
  allocation: {
    byPosition: AllocSlice[];
    bySector: AllocSlice[];
  };
  allocView: AllocView;
  onAllocViewChange: (v: AllocView) => void;
  horizon: AllocHorizon;
  onHorizonChange: (h: AllocHorizon) => void;
  rrAlloc: ReturnRiskAlloc | undefined;
}

export function CapitalAllocationCard({
  totalValue,
  allocation,
  allocView,
  onAllocViewChange,
  horizon,
  onHorizonChange,
  rrAlloc,
}: CapitalAllocationCardProps) {
  const needsHorizonData = allocView === "byReturn" || allocView === "byRisk";

  let donutSlices: DonutSlice[] = [];
  let centerLabel = "";
  let centerSub = "";
  let centerColor: string | undefined;
  let tooltipFormatter: (
    value: unknown,
    name?: string | number,
    entry?: unknown,
  ) => string = (v) => `${(v as number).toFixed(1)}%`;
  let dimensionLoading = false;

  if (allocView === "byPosition") {
    const items = (allocation.byPosition ?? []).slice().sort((a, b) => b.value - a.value);
    donutSlices = items.map((s) => ({
      name: s.name,
      value: s.value,
      secondary: `${(s.pct * 100).toFixed(1)}%`,
    }));
    centerLabel = fmtCompact$(totalValue);
    centerSub = "Total Value";
    tooltipFormatter = (v) => fmtCompact$(v as number);
  } else if (allocView === "bySector") {
    const items = (allocation.bySector ?? []).slice().sort((a, b) => b.value - a.value);
    donutSlices = items.map((s) => ({
      name: s.name,
      value: s.value,
      secondary: `${(s.pct * 100).toFixed(1)}%`,
    }));
    centerLabel = fmtCompact$(totalValue);
    centerSub = "Total Value";
    tooltipFormatter = (v) => fmtCompact$(v as number);
  } else if (allocView === "byReturn") {
    if (!rrAlloc) {
      dimensionLoading = true;
    } else {
      const items = rrAlloc.byReturn.slice().sort((a, b) => b.value - a.value);
      donutSlices = items.map((s) => ({
        name: s.name,
        value: s.value,
        negative: s.negative,
        secondary: fmtPctSigned(s.signed),
      }));
      centerLabel = fmtPctSigned(rrAlloc.totals.returnPct);
      centerSub = `Total Return (${rrAlloc.horizon})`;
      centerColor = rrAlloc.totals.returnPct >= 0 ? POSITIVE_HEX : NEGATIVE_HEX;
      tooltipFormatter = (_v, _n, entry) => {
        const p = (entry as { payload?: { signed?: number } } | undefined)?.payload;
        return p && typeof p.signed === "number"
          ? fmtPctSigned(p.signed)
          : `${((_v as number) * 100).toFixed(2)}%`;
      };
    }
  } else if (allocView === "byRisk") {
    if (!rrAlloc) {
      dimensionLoading = true;
    } else {
      const items = rrAlloc.byRisk.slice().sort((a, b) => b.value - a.value);
      donutSlices = items.map((s) => ({
        name: s.name,
        value: s.value,
        secondary: `${fmtCompact$(s.dollar)} / ${(s.pct * 100).toFixed(1)}%`,
      }));
      centerLabel = fmtCompact$(rrAlloc.totals.varDollar);
      centerSub = `${(rrAlloc.totals.varPct * 100).toFixed(2)}% Total VaR (${rrAlloc.horizon})`;
      tooltipFormatter = (_v, _n, entry) => {
        const p = (entry as { payload?: { dollar?: number; pct?: number } } | undefined)?.payload;
        return p && typeof p.dollar === "number" && typeof p.pct === "number"
          ? `${fmtCompact$(p.dollar)} (${(p.pct * 100).toFixed(1)}%)`
          : "";
      };
    }
  }

  return (
    <ChartCard
      title="Capital Allocation"
      compact
      fillHeight
      action={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {needsHorizonData && (
            <div style={{ display: "flex", gap: 2 }}>
              {HORIZON_OPTIONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => onHorizonChange(h)}
                  style={horizon === h ? btnActive : btnGhost}
                >
                  {h}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 2 }}>
            {ALLOC_VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => onAllocViewChange(v.id)}
                style={allocView === v.id ? btnActive : btnGhost}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {dimensionLoading ? (
        <div
          style={{
            flex: 1,
            minHeight: 260,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-secondary)",
            fontSize: 12,
            fontFamily: BB_GRID_FONT_STACK,
          }}
        >
          Loading {allocView === "byReturn" ? "returns" : "risk"}…
        </div>
      ) : (
        <Donut
          data={donutSlices}
          centerLabel={centerLabel}
          centerSub={centerSub}
          centerColor={centerColor}
          height={260}
          formatter={tooltipFormatter}
        />
      )}
    </ChartCard>
  );
}
