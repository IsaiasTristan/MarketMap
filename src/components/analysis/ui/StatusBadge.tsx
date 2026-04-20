type Severity = "ok" | "warning" | "error" | "info" | "stale";

const STYLES: Record<Severity, { color: string; bg: string; icon: string }> = {
  ok: { color: "var(--color-positive)", bg: "rgba(34,197,94,0.1)", icon: "●" },
  warning: { color: "var(--color-warning)", bg: "rgba(245,158,11,0.1)", icon: "●" },
  error: { color: "var(--color-negative)", bg: "rgba(239,68,68,0.1)", icon: "●" },
  info: { color: "var(--color-info)", bg: "rgba(56,189,248,0.1)", icon: "●" },
  stale: { color: "var(--color-neutral)", bg: "rgba(107,114,128,0.1)", icon: "●" },
};

interface StatusBadgeProps {
  severity: Severity;
  label: string;
}

export function StatusBadge({ severity, label }: StatusBadgeProps) {
  const s = STYLES[severity];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 12,
        color: s.color,
        background: s.bg,
        borderRadius: 4,
        padding: "2px 8px",
        fontWeight: 500,
      }}
    >
      <span style={{ fontSize: 8 }}>{s.icon}</span>
      {label}
    </span>
  );
}
