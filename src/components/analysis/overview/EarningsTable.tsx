"use client";
/**
 * EARNINGS — a plain three-column table of the whole book's next prints
 * (Earnings Date · Days Until · Name), ordered by soonest upcoming date. A held
 * name with no stored upcoming date sorts last and shows "—" (the server sorts;
 * this just renders). A print on a held position is a risk event regardless of
 * any signal, so every holding appears. Rows deep-link to the Revisions
 * calendar tab.
 */
import { useRouter } from "next/navigation";
import type { EarningsItemDto } from "@/server/services/signal-brief.service";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export function EarningsTable({ items, noDate }: { items: EarningsItemDto[]; noDate: string[] }) {
  const router = useRouter();

  if (items.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)" }}>
        No holdings in the research universe yet.
      </div>
    );
  }

  return (
    <div style={{ maxHeight: 320, overflowY: "auto" }}>
      <table className="bb-table" style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
            <th style={{ padding: "3px 8px", fontWeight: 400 }}>Earnings Date</th>
            <th style={{ padding: "3px 8px", fontWeight: 400, textAlign: "right" }}>Days Until</th>
            <th style={{ padding: "3px 8px", fontWeight: 400 }}>Name</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr
              key={it.ticker}
              onClick={() => router.push(`/research?tab=calendar&ticker=${it.ticker}`)}
              style={{ borderTop: "1px solid var(--chrome-border)", cursor: "pointer" }}
            >
              <td className="bb-num" style={{ padding: "3px 8px", color: it.erDate ? "var(--text-primary)" : "var(--text-muted)" }}>
                {fmtDate(it.erDate)}
              </td>
              <td className="bb-num" style={{ padding: "3px 8px", textAlign: "right", color: it.days != null && it.days <= 7 ? "var(--color-accent)" : "var(--text-primary)" }}>
                {it.days == null ? "—" : it.days === 0 ? "today" : `${it.days}d`}
              </td>
              <td style={{ padding: "3px 8px" }}>
                <span style={{ fontWeight: 700, color: "var(--color-accent)" }}>{it.ticker}</span>
                {it.side === "SHORT" ? <span style={{ color: "var(--text-muted)" }}> (S)</span> : null}
                {it.companyName ? <span style={{ color: "var(--text-muted)" }}> · {it.companyName}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {noDate.length > 0 && (
        <div style={{ padding: "4px 8px", fontSize: 9, color: "var(--text-muted)" }}>
          not onboarded yet: {noDate.join(", ")}
        </div>
      )}
    </div>
  );
}
