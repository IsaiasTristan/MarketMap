"use client";
/**
 * Engine 1 deep-link pusher (mirrors flows/funds/FundLink). Navigates to the
 * research page's URL contract:
 *   /research?tab=<tab>[&ticker=][&group=][&groupType=]
 * ResearchClient reads these params reactively, so GOTO chips on the Summary
 * feed, the QUEUE column on Rating Changes, and Decomp group links all resolve
 * to pre-filtered tabs.
 */
import { useRouter } from "next/navigation";

export function GotoLink({
  tab,
  ticker,
  group,
  groupType,
  children,
  style,
}: {
  tab: string;
  ticker?: string | null;
  group?: string | null;
  groupType?: string | null;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const router = useRouter();
  const params = new URLSearchParams({ tab });
  if (ticker) params.set("ticker", ticker);
  if (group) params.set("group", group);
  if (groupType) params.set("groupType", groupType);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        router.push(`/research?${params.toString()}`);
      }}
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "pointer",
        color: "var(--color-info)",
        font: "inherit",
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.5,
        textDecoration: "none",
        ...style,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
      onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
    >
      {children}
    </button>
  );
}
