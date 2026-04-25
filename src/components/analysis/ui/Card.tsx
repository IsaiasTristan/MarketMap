import type { CSSProperties, ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function Card({ children, style, className }: CardProps) {
  return (
    <div
      className={className}
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        borderRadius: 0,
        padding: "6px 8px",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function CardLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: "var(--text-label)",
        textTransform: "uppercase",
        letterSpacing: "0.3px",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2
      style={{
        fontSize: 13,
        fontWeight: 700,
        color: "var(--text-primary)",
        textTransform: "uppercase",
        letterSpacing: "0.3px",
        margin: "0 0 12px",
      }}
    >
      {children}
    </h2>
  );
}
