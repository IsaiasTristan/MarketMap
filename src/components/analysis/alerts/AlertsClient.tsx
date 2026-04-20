"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { StatusBadge } from "@/components/analysis/ui/StatusBadge";
import { Card } from "@/components/analysis/ui/Card";

type AlertRow = {
  id: string;
  at: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  type: string;
  message: string;
  contextJson: unknown;
  dismissedAt: string | null;
};

const SEVERITY_MAP = {
  INFO: "info" as const,
  WARNING: "warning" as const,
  CRITICAL: "error" as const,
};

const TYPE_ICONS: Record<string, string> = {
  drawdown: "📉",
  stop_loss: "⛔",
  crowding: "👥",
  factor_breach: "⚠",
};

export function AlertsClient() {
  const { activePortfolioId } = useAnalysisStore();
  const qc = useQueryClient();

  const { data: alerts = [], isLoading } = useQuery<AlertRow[]>({
    queryKey: ["alerts"],
    queryFn: () => fetch("/api/analysis/alerts").then((r) => r.json()),
    refetchInterval: 60_000,
  });

  const dismissMut = useMutation({
    mutationFn: (id: string) =>
      fetch("/api/analysis/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss", id }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });

  const generateMut = useMutation({
    mutationFn: () =>
      fetch("/api/analysis/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", portfolioId: activePortfolioId }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });

  const activeAlerts = alerts.filter((a) => !a.dismissedAt);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
            Alerts
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
            {activeAlerts.length} active alert{activeAlerts.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={() => generateMut.mutate()}
          disabled={generateMut.isPending || !activePortfolioId}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "1px solid var(--bg-border)",
            background: "transparent",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          {generateMut.isPending ? "Generating…" : "↻ Generate Alerts"}
        </button>
      </div>

      {isLoading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 24 }}>Loading alerts…</div>
      ) : activeAlerts.length === 0 ? (
        <Card>
          <div style={{ textAlign: "center", padding: 48 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
              No active alerts
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              Generate alerts to check for drawdowns, stop-loss breaches, and crowding.
            </div>
          </div>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {activeAlerts.map((alert) => (
            <div
              key={alert.id}
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--bg-border)",
                borderLeft: `4px solid ${
                  alert.severity === "CRITICAL"
                    ? "var(--color-negative)"
                    : alert.severity === "WARNING"
                      ? "var(--color-warning)"
                      : "var(--color-info)"
                }`,
                borderRadius: "0 8px 8px 0",
                padding: "12px 16px",
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              <span style={{ fontSize: 20 }}>{TYPE_ICONS[alert.type] ?? "⚠"}</span>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <StatusBadge
                    severity={SEVERITY_MAP[alert.severity]}
                    label={alert.severity}
                  />
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {new Date(alert.at).toLocaleString()}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "var(--text-primary)" }}>{alert.message}</div>
              </div>
              <button
                onClick={() => dismissMut.mutate(alert.id)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: 4,
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Threshold settings */}
      <ChartCard title="Alert Thresholds">
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Default thresholds: Drawdown warn at −3%, critical at −7%. Stop-loss at −10% from entry. Short ratio crowding alert at &gt;5 days.
          Customize via AppSettings (database) or a future settings UI.
        </div>
      </ChartCard>
    </div>
  );
}
