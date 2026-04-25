"use client";
import type { FactorAlert } from "@/types/factors";

interface AlertsPanelProps {
  alerts: FactorAlert[];
}

const SEVERITY_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  INFO: { bg: "rgba(56,189,248,0.06)", border: "rgba(56,189,248,0.25)", text: "var(--chart-4)" },
  WARNING: { bg: "rgba(245,158,11,0.06)", border: "rgba(245,158,11,0.25)", text: "#f59e0b" },
  CRITICAL: { bg: "rgba(239,68,68,0.06)", border: "rgba(239,68,68,0.25)", text: "#ef4444" },
};

const TYPE_LABELS: Record<string, string> = {
  factor_drift: "Factor Drift",
  factor_concentration: "Factor Concentration",
  active_risk_spike: "Active Risk Spike",
  alpha_deterioration: "Alpha Deterioration",
  sector_domination: "Sector Domination",
  factor_breach: "Factor Breach",
};

export function AlertsPanel({ alerts }: AlertsPanelProps) {
  if (!alerts.length) {
    return (
      <div
        style={{
          padding: "20px 16px",
          background: "var(--bg-surface)",
          border: "1px solid var(--bg-border)",
          borderRadius: 2,
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 13,
          color: "var(--text-muted)",
        }}
      >
        <span style={{ fontSize: 18 }}>✓</span>
        No active factor alerts. Portfolio factor exposure is within normal parameters.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {alerts.map((alert) => {
        const colors = SEVERITY_COLORS[alert.severity] ?? SEVERITY_COLORS.WARNING!;
        return (
          <div
            key={alert.id}
            style={{
              padding: "12px 16px",
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              borderRadius: 2,
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
            }}
          >
            <div style={{ flexShrink: 0, marginTop: 1 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: colors.text,
                  background: `${colors.text}18`,
                  padding: "2px 8px",
                  borderRadius: 3,
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                }}
              >
                {TYPE_LABELS[alert.type] ?? alert.type}
              </span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.5 }}>
                {alert.message}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                {new Date(alert.at).toLocaleString()}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
