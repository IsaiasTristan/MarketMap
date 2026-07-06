"use client";
/**
 * EARNINGS — NEXT 3 WEEKS. A simple horizontal timeline of upcoming prints:
 * held names (amber, with position weight — a print on a held position is a
 * risk event regardless of signal) and current idea-queue names (blue, with
 * L/S side). Detail lives on the Revisions calendar tab — this module links
 * there. Lightweight positioned HTML, no chart library.
 */
import { useRouter } from "next/navigation";
import type { EarningsItemDto } from "@/server/services/signal-brief.service";

const HELD_COLOR = "#ffb000"; // amber
const QUEUE_COLOR = "#5aa0ff"; // blue (matches the research DOMINO/queue accent)

function dayLabel(offset: number): string {
  const d = new Date(Date.now() + offset * 86_400_000);
  return d.toISOString().slice(5, 10).replace("-", "/");
}

export function EarningsTimeline({
  items,
  windowDays,
  noDate,
}: {
  items: EarningsItemDto[];
  windowDays: number;
  noDate: string[];
}) {
  const router = useRouter();

  // Bucket by ER date so same-day names stack vertically under one tick.
  const buckets = new Map<string, { days: number; rows: EarningsItemDto[] }>();
  for (const it of items) {
    const b = buckets.get(it.erDate) ?? { days: it.days, rows: [] };
    b.rows.push(it);
    buckets.set(it.erDate, b);
  }
  const cols = [...buckets.values()].sort((a, b) => a.days - b.days);
  const maxStack = cols.reduce((m, c) => Math.max(m, c.rows.length), 0);
  const axisTicks = [0, 7, 14, windowDays];

  return (
    <div style={{ padding: "8px 10px 6px" }}>
      {items.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "6px 0" }}>
          No held or queue names report in the next {windowDays} days.
        </div>
      ) : (
        <div style={{ position: "relative", height: 26 + maxStack * 15, minHeight: 48 }}>
          {/* axis */}
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 8,
              borderTop: "1px solid var(--chrome-border)",
            }}
          />
          {axisTicks.map((d) => (
            <div
              key={d}
              style={{
                position: "absolute",
                left: `${(d / windowDays) * 100}%`,
                top: 4,
                transform: d === 0 ? "none" : d === windowDays ? "translateX(-100%)" : "translateX(-50%)",
                fontSize: 8,
                color: "var(--text-muted)",
              }}
            >
              <div style={{ width: 1, height: 5, background: "var(--chrome-border)", margin: d === 0 ? "0 0 1px 0" : "0 auto 1px" }} />
              {d === 0 ? "TODAY" : dayLabel(d)}
            </div>
          ))}
          {/* markers */}
          {cols.map((c) => {
            const pct = Math.min(Math.max((c.days / windowDays) * 100, 1), 99);
            return (
              <div
                key={c.rows[0]!.erDate}
                style={{
                  position: "absolute",
                  left: `${pct}%`,
                  top: 22,
                  transform: pct > 88 ? "translateX(-100%)" : pct > 8 ? "translateX(-50%)" : "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  alignItems: "flex-start",
                }}
              >
                {c.rows.map((r) => (
                  <button
                    key={`${r.ticker}-${r.held}`}
                    type="button"
                    onClick={() => router.push(`/research?tab=calendar&ticker=${r.ticker}`)}
                    title={`${r.ticker} reports ${r.erDate}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 3,
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      fontSize: 9,
                      fontWeight: 700,
                      whiteSpace: "nowrap",
                      color: r.held ? HELD_COLOR : QUEUE_COLOR,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: r.held ? 0 : 3,
                        background: r.held ? HELD_COLOR : QUEUE_COLOR,
                      }}
                    />
                    {r.ticker}
                    <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                      {r.held
                        ? r.weight != null
                          ? `${(r.weight * 100).toFixed(1)}%`
                          : ""
                        : r.side === "SHORT"
                          ? "S"
                          : "L"}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", gap: 12, fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>
        <span>
          <span style={{ color: HELD_COLOR }}>■</span> held (weight)
        </span>
        <span>
          <span style={{ color: QUEUE_COLOR }}>●</span> idea queue (L/S)
        </span>
        {noDate.length > 0 && <span>no ER date yet (onboarding): {noDate.join(", ")}</span>}
      </div>
    </div>
  );
}
