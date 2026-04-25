type Severity = "ok" | "warning" | "error" | "info" | "stale";

const STYLES: Record<Severity, { color: string; bg: string; icon: string }> = {
  ok: { color: "#000", bg: "var(--bb-green)", icon: "●" },
  warning: { color: "#000", bg: "var(--bb-amber-bg)", icon: "●" },
  error: { color: "#fff", bg: "var(--bb-red)", icon: "●" },
  info: { color: "#fff", bg: "var(--bb-chrome)", icon: "●" },
  stale: { color: "#fff", bg: "var(--color-neutral)", icon: "●" },
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
        fontSize: 11,
        color: s.color,
        background: s.bg,
        borderRadius: 0,
        padding: "2px 8px",
        fontWeight: 600,
        border: "1px solid var(--chrome-border)",
      }}
    >
      <span style={{ fontSize: 8 }}>{s.icon}</span>
      {label}
    </span>
  );
}
