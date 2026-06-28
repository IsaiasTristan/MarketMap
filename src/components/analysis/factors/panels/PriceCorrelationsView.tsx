"use client";
/**
 * PriceCorrelationsView — the "Price correlations" top-level Factors tab.
 *
 * Stacks two Bloomberg-style correlation heatmaps for the active universe:
 *   1. Sector Performance Correlations    (sector × sector)
 *   2. Subsector Performance Correlations (sub-theme × sub-theme, global)
 *
 * Both are driven by one 1M/3M/6M/1Y window control and are computed from
 * equal-weight daily return series aggregated by group from PriceHistory.
 */
import { useQuery } from "@tanstack/react-query";
import { useAnalysisStore, type PriceCorrWindow } from "@/store/analysis";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import { sectorColor } from "@/lib/market-map/sector-colors";
import { CorrelationMatrixTable } from "./CorrelationMatrixTable";

interface CorrelationMatrixPayload {
  labels: string[];
  matrix: number[][];
  obs: number;
  asOf: string | null;
  window: number;
}

interface MarketCorrelationsResult {
  sector: CorrelationMatrixPayload;
  subTheme: CorrelationMatrixPayload;
  warnings: string[];
}

const WINDOW_OPTIONS: { label: string; value: PriceCorrWindow }[] = [
  { label: "1M", value: 21 },
  { label: "3M", value: 63 },
  { label: "6M", value: 126 },
  { label: "1Y", value: 252 },
];

function WindowSelect({
  value,
  onChange,
}: {
  value: PriceCorrWindow;
  onChange: (v: PriceCorrWindow) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <span
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-muted)",
          marginRight: 4,
        }}
      >
        Window
      </span>
      {WINDOW_OPTIONS.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              padding: "3px 10px",
              borderRadius: 5,
              border: `1px solid ${active ? "var(--color-accent)" : "var(--bg-border)"}`,
              background: active ? "var(--color-accent)" : "transparent",
              color: active ? "#fff" : "var(--text-secondary)",
              fontSize: 11,
              fontWeight: active ? 600 : 400,
              cursor: "pointer",
              transition: "all 0.12s",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function metaLine(p: CorrelationMatrixPayload, noun: string): string {
  const asOf = p.asOf ?? "—";
  return `${p.labels.length} ${noun} · SYMMETRIC · ${p.obs}D WINDOW · AS OF ${asOf}`;
}

export function PriceCorrelationsView() {
  const { priceCorrWindow, setPriceCorrWindow } = useAnalysisStore();

  const { data, isLoading } = useQuery<MarketCorrelationsResult>({
    queryKey: ["price-correlations", priceCorrWindow],
    queryFn: () =>
      fetch(`/api/analysis/correlations/market?window=${priceCorrWindow}`).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <WindowSelect value={priceCorrWindow} onChange={setPriceCorrWindow} />
      </div>

      {isLoading ? (
        <SkeletonCard height={460} />
      ) : (
        <>
          <ChartCard
            title="Sector Performance Correlations"
            subtitle="Pearson correlations of equal-weight sector daily returns from the universe price history."
          >
            {data?.sector ? (
              <CorrelationMatrixTable
                labels={data.sector.labels}
                matrix={data.sector.matrix}
                rowAccents={data.sector.labels.map((s) => sectorColor(s))}
                metaLine={metaLine(data.sector, "SECTORS")}
              />
            ) : (
              <EmptyPanel />
            )}
          </ChartCard>

          <ChartCard
            title="Subsector Performance Correlations"
            subtitle="Pearson correlations of equal-weight sub-theme daily returns (all sub-themes across the universe)."
          >
            {data?.subTheme ? (
              <CorrelationMatrixTable
                labels={data.subTheme.labels}
                matrix={data.subTheme.matrix}
                rowAccents={data.subTheme.labels.map((l) => sectorColor(l.split(" / ")[0]))}
                metaLine={metaLine(data.subTheme, "SUB-THEMES")}
              />
            ) : (
              <EmptyPanel />
            )}
          </ChartCard>
        </>
      )}
    </div>
  );
}

function EmptyPanel() {
  return (
    <div
      style={{
        padding: 24,
        background: "var(--bg-surface)",
        color: "var(--text-secondary)",
        fontSize: 12,
        fontFamily: "var(--font-mono, monospace)",
      }}
    >
      NO PRICE DATA AVAILABLE — ADD CONSTITUENTS AND RUN A PRICE INGEST FIRST.
    </div>
  );
}
