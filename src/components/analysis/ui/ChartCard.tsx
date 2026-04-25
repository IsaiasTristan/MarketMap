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
        fontSize: 10,
        color: "var(--bb-chrome-text)",
        background: "var(--bb-chrome)",
        border: "1px solid var(--chrome-border)",
        borderRadius: 0,
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
        borderRadius: 0,
        overflow: "hidden",
        ...style,
      }}
    >
      <div
        style={{
          height: 20,
          background: "var(--bb-chrome)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 10px",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.07em",
          color: "#fff",
          textTransform: "uppercase",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
        <div style={{ flex: 1 }} />
        {provenance && <ProvenanceBadge {...provenance} />}
        {action}
      </div>
      {subtitle ? (
        <div
          style={{
            padding: "6px 10px",
            fontSize: 10,
            color: "var(--text-muted)",
            borderBottom: "1px solid var(--bg-border)",
            background: "var(--bg-base)",
          }}
        >
          {subtitle}
        </div>
      ) : null}
      <div style={{ padding: "6px 8px" }}>{children}</div>
    </div>
  );
}
