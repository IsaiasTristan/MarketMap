"use client";
/** 5.5 Single-name fund ledger — the actual roster. No composite, just the ledger. */
import type { LedgerPayload, LedgerRow } from "@/server/services/institutional/institutional-query.service";
import { DataTable, type Column } from "@/components/analysis/ui/DataTable";
import { useFlows } from "./useFlows";
import { ActionPill, CapTag, PanelState } from "./flowsUi";

export function LedgerPanel({ ticker, period, onClose }: { ticker: string; period: string | null; onClose: () => void }) {
  const { data, state, error } = useFlows<LedgerPayload>(
    ["flows-ledger", ticker, period],
    `/api/analysis/flows/ledger?ticker=${encodeURIComponent(ticker)}${period ? `&period=${period}` : ""}`,
  );

  const columns: Column<LedgerRow>[] = [
    { key: "fundName", label: "Fund", render: (r) => (
      <span>
        {r.fundName}
        {r.isMostRespected ? <span title="most-respected subset" style={{ color: "var(--color-accent)", marginLeft: 4 }}>★</span> : null}
        <span style={{ color: "var(--text-muted)", fontSize: 10, marginLeft: 6 }}>T{r.tier}</span>
      </span>
    ), sortValue: (r) => r.fundName },
    { key: "action", label: "Action", align: "center", render: (r) => <ActionPill action={r.action} />, sortValue: (r) => r.action },
    { key: "positionM", label: "Position ($M)", align: "right", render: (r) => `$${r.positionM.toLocaleString()}M`, sortValue: (r) => r.positionM },
    { key: "pctOfBook", label: "% of book", align: "right", render: (r) => (r.pctOfBook === null ? "—" : `${r.pctOfBook}%`), sortValue: (r) => r.pctOfBook ?? -1,
      colorize: (r) => ((r.pctOfBook ?? 0) >= 2 ? "warning" : null) },
  ];

  return (
    <div style={{ border: "1px solid var(--color-accent)", background: "var(--bg-base)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "6px 10px", background: "var(--bb-chrome)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{ticker}</span>
          {data && <CapTag tier={data.marketCapTier} />}
          {data?.companyName && <span style={{ fontSize: 11, opacity: 0.9 }}>{data.companyName}</span>}
          {data?.sector && <span style={{ fontSize: 10, opacity: 0.7 }}>· {data.sector}</span>}
        </div>
        <button type="button" onClick={onClose} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.4)", color: "#fff", fontSize: 11, padding: "1px 8px", cursor: "pointer" }}>✕ close</button>
      </div>
      <div style={{ padding: 10 }}>
        <PanelState state={state} error={error}>
          {data && (
            <>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 8 }}>
                <b style={{ color: "var(--text-primary)" }}>{data.fundsHolding}</b> of {data.trackedFunds} tracked funds hold ·{" "}
                <span style={{ color: "var(--color-positive)" }}>{data.fundsAddedOrNew} added or new</span> ·{" "}
                <span style={{ color: "var(--color-negative)" }}>{data.fundsTrimmed} trimmed</span> ·{" "}
                <span style={{ color: "var(--color-negative)" }}>{data.fundsExited} exited</span>
                <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>sort by % of book — the conviction dimension</span>
              </div>
              <DataTable columns={columns} rows={data.rows} getRowKey={(r) => r.fundName} searchable={false} pageSize={30} exportFilename={`${ticker}-ledger.csv`} />
            </>
          )}
        </PanelState>
      </div>
    </div>
  );
}
