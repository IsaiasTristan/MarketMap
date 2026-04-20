import type { CSSProperties } from "react";

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}

export function Skeleton({ width = "100%", height = 16, style }: SkeletonProps) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 4,
        background:
          "linear-gradient(90deg, var(--bg-elevated) 25%, var(--bg-border) 50%, var(--bg-elevated) 75%)",
        backgroundSize: "200% 100%",
        animation: "skeleton-shimmer 1.5s infinite",
        ...style,
      }}
    />
  );
}

export function SkeletonCard({
  rows = 3,
  height = 120,
}: {
  rows?: number;
  height?: number;
}) {
  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        borderRadius: 12,
        padding: 16,
        height,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <Skeleton width="40%" height={12} />
      <Skeleton width="70%" height={28} />
      {rows > 2 && <Skeleton width="50%" height={12} />}
      <style>{`
        @keyframes skeleton-shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
      `}</style>
    </div>
  );
}
