import type { ReactNode } from "react";

interface ProvenanceBadgeProps {
  frenchThrough: string;
  proxyFrom: string;
  proxyTo: string;
}

export function ProvenanceBadge({ frenchThrough, proxyFrom, proxyTo }: ProvenanceBadgeProps) {
  return (
    <div
      title={`Factor returns for the most recent period use ETF-based proxies normalized to match Fama-French return distributions. Historical periods use official published factors.`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        color: "var(--color-info)",
        background: "rgba(56,189,248,0.08)",
        border: "1px solid rgba(56,189,248,0.2)",
        borderRadius: 4,
        padding: "2px 8px",
        cursor: "help",
      }}
    >
      <span>ⓘ</span>
      French data through {frenchThrough} · Proxy data {proxyFrom} to {proxyTo}
    </div>
  );
}

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  provenance?: ProvenanceBadgeProps;
  action?: ReactNode;
  style?: React.CSSProperties;
}

export function ChartCard({ title, subtitle, children, provenance, action, style }: ChartCardProps) {
  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        borderRadius: 12,
        padding: 20,
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 16,
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: subtitle ? 4 : 0,
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {subtitle}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {provenance && <ProvenanceBadge {...provenance} />}
          {action}
        </div>
      </div>
      {children}
    </div>
  );
}
