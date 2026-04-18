import type { Horizon } from "@/domain/entities/horizons";

export const HORIZON_LABEL: Record<Horizon, string> = {
  D1: "1D",
  D5: "5D",
  M1: "1M",
  M3: "3M",
  M6: "6M",
  Y1: "1Y",
};

export function formatMetricValue(
  v: number | null,
  metric: "RETURN" | "EXCESS_RETURN" | "VOLATILITY" | "SHARPE"
): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (metric === "VOLATILITY" || metric === "RETURN" || metric === "EXCESS_RETURN") {
    return `${(v * 100).toFixed(2)}%`;
  }
  return v.toFixed(2);
}
