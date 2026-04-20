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
        borderRadius: 12,
        padding: 16,
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
        fontSize: 12,
        fontWeight: 500,
        color: "var(--text-secondary)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        marginBottom: 8,
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
        fontSize: 15,
        fontWeight: 600,
        color: "var(--text-primary)",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        margin: "0 0 16px",
      }}
    >
      {children}
    </h2>
  );
}
