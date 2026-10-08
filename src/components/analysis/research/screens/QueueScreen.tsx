"use client";
/**
 * Screen 2 — the research queue. One table, one rank, filters in the URL.
 *
 * The default view is |score| >= 1 on both sides, interleaved by magnitude:
 * the screen is a funnel, so it opens on the names it is actually confident
 * about rather than the whole universe.
 */
import { PanelState } from "@/components/analysis/ui/PanelState";
import { QueueTable } from "./QueueTable";
import { QUEUE_DEFAULTS, useQueueQuery, useQueueScreen, type Side } from "./useScreens";

const CAPS = [
  { value: "", label: "Any size" },
  { value: "MICRO", label: "< $300M" },
  { value: "SMALL", label: "$300M–$2B" },
  { value: "MID", label: "$2B–$10B" },
  { value: "LARGE", label: "> $10B" },
];
const COVS = [
  { value: "", label: "Any coverage" },
  { value: "THIN", label: "1–4 analysts" },
  { value: "MID", label: "5–10 analysts" },
  { value: "DEEP", label: "11+ analysts" },
];
const SIDES: Array<{ value: Side; label: string }> = [
  { value: "both", label: "Both" },
  { value: "long", label: "Raising" },
  { value: "short", label: "Cutting" },
];

const control: React.CSSProperties = {
  background: "var(--bg-base)",
  border: "1px solid var(--chrome-border)",
  color: "var(--text-primary)",
  fontSize: 10,
  padding: "2px 5px",
  fontFamily: "inherit",
};
const labelStyle: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  display: "flex",
  alignItems: "center",
  gap: 4,
};

export function QueueScreen() {
  const { query, set } = useQueueQuery();
  const { data, state, error } = useQueueScreen(query);

  const pageSize = QUEUE_DEFAULTS.pageSize;
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(query.page, pages);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          padding: "6px 8px",
          border: "1px solid var(--chrome-border)",
          background: "var(--bg-surface)",
        }}
      >
        <div style={{ display: "flex", gap: 1 }}>
          {SIDES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => set({ side: s.value })}
              style={{
                ...control,
                fontWeight: 700,
                cursor: "pointer",
                color: query.side === s.value ? "#000" : "var(--text-muted)",
                background: query.side === s.value ? "var(--color-accent)" : "var(--bg-base)",
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        <label style={labelStyle}>
          Min score
          <input
            type="number"
            step={0.25}
            min={0}
            value={query.minZ}
            onChange={(e) => set({ minZ: Number(e.target.value) })}
            style={{ ...control, width: 54 }}
          />
        </label>

        <label style={labelStyle}>
          Size
          <select value={query.cap ?? ""} onChange={(e) => set({ cap: e.target.value || undefined })} style={control}>
            {CAPS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label style={labelStyle}>
          Coverage
          <select value={query.cov ?? ""} onChange={(e) => set({ cov: e.target.value || undefined })} style={control}>
            {COVS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label style={labelStyle}>
          Industry
          <select
            value={query.subsector ?? ""}
            onChange={(e) => set({ subsector: e.target.value || undefined })}
            style={{ ...control, maxWidth: 190 }}
          >
            <option value="">All industries</option>
            {(data?.subsectors ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label style={labelStyle}>
          Weeks in top 10% ≥
          <input
            type="number"
            min={0}
            max={26}
            value={query.minWeeks ?? ""}
            onChange={(e) => set({ minWeeks: e.target.value ? Number(e.target.value) : undefined })}
            style={{ ...control, width: 44 }}
          />
        </label>

        <label style={labelStyle}>
          Earnings within
          <input
            type="number"
            min={0}
            max={90}
            value={query.er ?? ""}
            onChange={(e) => set({ er: e.target.value ? Number(e.target.value) : undefined })}
            style={{ ...control, width: 44 }}
          />
          days
        </label>

        <label style={labelStyle}>
          <input type="checkbox" checked={Boolean(query.new)} onChange={(e) => set({ new: e.target.checked || undefined })} />
          New this week
        </label>

        <label style={labelStyle}>
          <input type="checkbox" checked={Boolean(query.tri)} onChange={(e) => set({ tri: e.target.checked || undefined })} />
          Two engines agree
        </label>

        <label style={labelStyle}>
          <input
            type="search"
            placeholder="Ticker"
            value={query.q ?? ""}
            onChange={(e) => set({ q: e.target.value.toUpperCase() || undefined })}
            style={{ ...control, width: 70 }}
          />
        </label>

        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
          {data ? `${total.toLocaleString()} names · week of ${data.snapshotDate}` : ""}
        </span>
      </div>

      <PanelState state={state} error={error}>
        {data && (
          <>
            <QueueTable rows={data.rows} startIndex={(page - 1) * pageSize} side={query.side} />
            {pages > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", fontSize: 10 }}>
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => set({ page: page - 1 })}
                  style={{ ...control, cursor: page <= 1 ? "default" : "pointer", opacity: page <= 1 ? 0.4 : 1 }}
                >
                  ← Prev
                </button>
                <span style={{ color: "var(--text-muted)" }}>
                  Page {page} of {pages}
                </span>
                <button
                  type="button"
                  disabled={page >= pages}
                  onClick={() => set({ page: page + 1 })}
                  style={{ ...control, cursor: page >= pages ? "default" : "pointer", opacity: page >= pages ? 0.4 : 1 }}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </PanelState>
    </div>
  );
}
