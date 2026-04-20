"use client";
import { useEffect } from "react";
import { useAnalysisStore } from "@/store/analysis";

const SEVERITY_STYLES = {
  info: { bg: "rgba(56,189,248,0.12)", border: "#38bdf8", icon: "ℹ" },
  success: { bg: "rgba(34,197,94,0.12)", border: "#22c55e", icon: "✓" },
  warning: { bg: "rgba(245,158,11,0.12)", border: "#f59e0b", icon: "⚠" },
  error: { bg: "rgba(239,68,68,0.12)", border: "#ef4444", icon: "✕" },
};

function ToastItem({ toast }: { toast: { id: string; message: string; severity: "info" | "success" | "warning" | "error" } }) {
  const { dismissToast } = useAnalysisStore();
  const style = SEVERITY_STYLES[toast.severity];

  useEffect(() => {
    const t = setTimeout(() => dismissToast(toast.id), 4000);
    return () => clearTimeout(t);
  }, [toast.id, dismissToast]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        background: style.bg,
        border: `1px solid ${style.border}`,
        borderRadius: 8,
        padding: "10px 14px",
        minWidth: 280,
        maxWidth: 380,
        boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
      }}
    >
      <span style={{ fontSize: 14, marginTop: 1 }}>{style.icon}</span>
      <span style={{ fontSize: 13, color: "var(--text-primary)", flex: 1 }}>
        {toast.message}
      </span>
      <button
        onClick={() => dismissToast(toast.id)}
        style={{
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 14,
          padding: 0,
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { toasts } = useAnalysisStore();

  if (!toasts.length) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 1000,
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
