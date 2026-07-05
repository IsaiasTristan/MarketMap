"use client";
/**
 * DECOMP — group vs idiosyncratic split of the universe-relative composite.
 * COMP here is the universe composite (grp + idio sum to it exactly); the Idea
 * Queue's rev z stays peer-relative — the registry tooltips spell out the
 * difference. Split bars are pure HTML cells (GroupIdioBar), no canvas.
 */
import { useMemo, useState } from "react";
import { PanelState } from "@/components/analysis/ui/PanelState";
import { useRevision } from "./useRevision";
import { MetricTip } from "./MetricTip";
import { GroupIdioBar, fmtZ, heatZ } from "./researchUi";
import type { RevMetricId } from "@/lib/revision/metric-registry";

interface DecompRow {
  ticker: string;
  companyName: string;
  groupKey: string;
  composite: number | null;
  groupZ: number | null;
  idioZ: number | null;
  implication: string;
}

interface DecompPayload {
  groupType: "SECTOR" | "SUBSECTOR";
  snapshotDate: string;
  rows: DecompRow[];
}

type SortKey = "idio" | "grp" | "comp";

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

export function DecompPanel({
  onOpenRotation,
  onSelectTicker,
}: {
  onOpenRotation: (groupType: "SECTOR" | "SUBSECTOR", key: string) => void;
  onSelectTicker: (t: string) => void;
}) {
  const [groupType, setGroupType] = useState<"SECTOR" | "SUBSECTOR">("SUBSECTOR");
  const [sortKey, setSortKey] = useState<SortKey>("idio");
  const { data, state, error } = useRevision<DecompPayload>(
    ["research-decomp", groupType],
    `/api/analysis/research/decomp?groupType=${groupType}`,
  );

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
    const keyOf = (r: DecompRow) =>
      sortKey === "idio" ? Math.abs(r.idioZ ?? 0) : sortKey === "grp" ? Math.abs(r.groupZ ?? 0) : r.composite ?? -Infinity;
    return list.sort((a, b) => keyOf(b) - keyOf(a)).slice(0, 300);
  }, [data, sortKey]);

  const segBtn = (active: boolean): React.CSSProperties => ({
    background: active ? "var(--bb-chrome)" : "var(--bg-surface)",
    color: active ? "#fff" : "var(--text-secondary)",
    border: "1px solid var(--chrome-border)",
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 0.5,
    padding: "3px 8px",
    cursor: "pointer",
    textTransform: "uppercase",
  });

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span>
              {(["SECTOR", "SUBSECTOR"] as const).map((g) => (
                <button key={g} type="button" style={segBtn(groupType === g)} onClick={() => setGroupType(g)}>
                  {g}
                </button>
              ))}
            </span>
            <span>
              {(
                [
                  ["idio", "|IDIO|"],
                  ["grp", "|GRP|"],
                  ["comp", "COMP"],
                ] as Array<[SortKey, string]>
              ).map(([k, label]) => (
                <button key={k} type="button" style={segBtn(sortKey === k)} onClick={() => setSortKey(k)}>
                  {label}
                </button>
              ))}
            </span>
            <span style={{ fontSize: 9, color: "var(--text-muted)" }}>
              universe-relative composite = grp + idio · as of {data.snapshotDate} · gray = group · amber = idio
            </span>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="bb-table" style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={th}>Ticker</th>
                  <Th id="globalComposite">Comp</Th>
                  <Th id="groupZ">Grp</Th>
                  <Th id="idioZ">Idio</Th>
                  <Th id="grpIdioSplit">Grp │ idio split</Th>
                  <Th id="implication">Implication</Th>
                  <th style={th}>Group</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ticker}>
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
                    <td className="bb-num" style={{ ...td, color: "var(--text-secondary)" }}>{fmtZ(r.groupZ)}</td>
                    <td className="bb-num" style={{ ...td, color: "var(--text-secondary)" }}>{fmtZ(r.idioZ)}</td>
                    <td style={td}>
                      <GroupIdioBar groupZ={r.groupZ} idioZ={r.idioZ} />
                    </td>
                    <td style={{ ...td, fontSize: 9, fontWeight: 700, color: r.implication.includes("IDIO") ? "var(--color-accent)" : "var(--text-muted)" }}>
                      {r.implication}
                    </td>
                    <td style={td}>
                      <button
                        type="button"
                        onClick={() => onOpenRotation(data.groupType, r.groupKey)}
                        style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--color-info)", font: "inherit", fontSize: 10 }}
                      >
                        {r.groupKey}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)" }}>NO DECOMPOSABLE NAMES THIS WEEK</div>
            )}
          </div>
        </div>
      )}
    </PanelState>
  );
}
