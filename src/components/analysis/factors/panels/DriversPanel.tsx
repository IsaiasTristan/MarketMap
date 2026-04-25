"use client";
import { useState } from "react";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { FactorBadge } from "../shared/FactorBadge";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import type { DriversResult, FactorCode, FactorDriverEntry } from "@/types/factors";

interface DriversPanelProps {
  drivers: DriversResult | null | undefined;
  groupBy: "position" | "sector" | "subTheme";
  onGroupByChange: (g: "position" | "sector" | "subTheme") => void;
}

function DriverBar({ entry, maxAbs }: { entry: FactorDriverEntry; maxAbs: number }) {
  const pct = maxAbs > 0 ? (Math.abs(entry.contribution) / maxAbs) * 100 : 0;
  const positive = entry.contribution >= 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
      <div style={{ width: 80, fontSize: 11, color: "var(--text-secondary)", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
        {entry.label}
      </div>
      <div style={{ flex: 1, height: 8, background: "var(--bg-elevated)", borderRadius: 4, overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: positive ? "var(--chart-1)" : "var(--color-negative)",
            borderRadius: 2,
          }}
        />
      </div>
      <div
        style={{
          width: 52,
          fontSize: 10,
          fontFamily: "var(--font-mono, monospace)",
          color: positive ? "var(--color-positive)" : "var(--color-negative)",
          textAlign: "right",
        }}
      >
        {entry.contribution >= 0 ? "+" : ""}
        {entry.contribution.toFixed(3)}
      </div>
    </div>
  );
}

export function DriversPanel({ drivers, groupBy, onGroupByChange }: DriversPanelProps) {
  const [activeFactor, setActiveFactor] = useState<string | null>(null);

  const groupByOptions: { value: "position" | "sector" | "subTheme"; label: string }[] = [
    { value: "sector", label: "Sector" },
    { value: "subTheme", label: "Sub-Theme" },
    { value: "position", label: "Position" },
  ];

  return (
    <ChartCard
      title="Factor Exposure Drivers"
      subtitle="Who is driving each factor? Top positive and negative contributors by weight × loading."
    >
      <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Group by:</span>
        {groupByOptions.map((o) => (
          <button
            key={o.value}
            onClick={() => onGroupByChange(o.value)}
            style={{
              padding: "3px 10px",
              borderRadius: 5,
              border: `1px solid ${groupBy === o.value ? "var(--color-accent)" : "var(--bg-border)"}`,
              background: groupBy === o.value ? "var(--color-accent)" : "transparent",
              color: groupBy === o.value ? "#fff" : "var(--text-secondary)",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        ))}
      </div>

      {!drivers ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)", fontSize: 13 }}>
          Insufficient price history for holdings-implied loadings.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
          {drivers.factors.map((f) => {
            const def = getFactorDef(f.code as FactorCode);
            const allEntries = [...f.topPositive, ...f.topNegative];
            const maxAbs = Math.max(...allEntries.map((e) => Math.abs(e.contribution)), 0.0001);

            return (
              <div
                key={f.code}
                style={{
                  background: "var(--bg-elevated)",
                  border: `1px solid ${def.color}30`,
                  borderRadius: 2,
                  padding: "12px 14px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <FactorBadge code={f.code as FactorCode} value={f.portfolioExposure} showValue />
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    HHI {(f.concentrationHHI * 100).toFixed(0)}%
                  </span>
                </div>

                {f.topPositive.length > 0 && (
                  <>
                    <div style={{ fontSize: 10, color: "var(--color-positive)", fontWeight: 600, marginBottom: 4, letterSpacing: "0.05em" }}>
                      ▲ POSITIVE
                    </div>
                    {f.topPositive.map((e) => (
                      <DriverBar key={e.key} entry={e} maxAbs={maxAbs} />
                    ))}
                  </>
                )}

                {f.topNegative.length > 0 && (
                  <>
                    <div style={{ fontSize: 10, color: "var(--color-negative)", fontWeight: 600, margin: "8px 0 4px", letterSpacing: "0.05em" }}>
                      ▼ NEGATIVE
                    </div>
                    {f.topNegative.map((e) => (
                      <DriverBar key={e.key} entry={e} maxAbs={maxAbs} />
                    ))}
                  </>
                )}

                {!f.topPositive.length && !f.topNegative.length && (
                  <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "8px 0" }}>No significant contributors.</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </ChartCard>
  );
}
