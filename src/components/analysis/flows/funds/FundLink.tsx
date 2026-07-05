"use client";
/**
 * Shared fund-name link (FUNDS Part 4b/5). Renders a fund name as a clickable
 * link that navigates to the Funds sub-tab's deep-link contract:
 * `/flows?tab=funds&fund=<cik>`. Used app-wide (Ledger, Leaderboard WHO chips,
 * the scoreboard, fresh calls, fund page cross-links) so every fund name in the
 * tool resolves to the same signal-provenance page.
 */
import { useRouter } from "next/navigation";

export function FundLink({
  cik,
  name,
  isElite,
  style,
}: {
  cik: string | null | undefined;
  name: string;
  isElite?: boolean;
  style?: React.CSSProperties;
}) {
  const router = useRouter();
  if (!cik) {
    // No CIK to resolve — render plain text rather than a dead link.
    return (
      <span style={style}>
        {name}
        {isElite ? <span title="most-respected subset" style={{ color: "var(--color-accent)", marginLeft: 4 }}>★</span> : null}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        router.push(`/flows?tab=funds&fund=${encodeURIComponent(cik)}`);
      }}
      title={`Open ${name} — signal provenance`}
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "pointer",
        color: "var(--color-info)",
        font: "inherit",
        textDecoration: "none",
        ...style,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
      onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
    >
      {name}
      {isElite ? <span title="most-respected subset" style={{ color: "var(--color-accent)", marginLeft: 4 }}>★</span> : null}
    </button>
  );
}
