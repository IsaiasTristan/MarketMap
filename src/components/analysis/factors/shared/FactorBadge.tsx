import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import type { FactorCode } from "@/types/factors";

interface FactorBadgeProps {
  code: FactorCode;
  value?: number;
  showValue?: boolean;
}

export function FactorBadge({ code, value, showValue = false }: FactorBadgeProps) {
  const def = getFactorDef(code);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: `${def.color}18`,
        border: `1px solid ${def.color}40`,
        borderRadius: 4,
        padding: "2px 8px",
        fontSize: 11,
        fontWeight: 600,
        color: def.color,
        fontFamily: "var(--font-jetbrains-mono, monospace)",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
      }}
    >
      {def.shortLabel}
      {showValue && value !== undefined && (
        <span style={{ fontWeight: 400, opacity: 0.85 }}>
          {value >= 0 ? "+" : ""}
          {value.toFixed(2)}
        </span>
      )}
    </span>
  );
}
