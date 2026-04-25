"use client";
import { useEffect } from "react";
import { useAnalysisStore } from "@/store/analysis";

const SEVERITY_STYLES = {
  info: { bg: "var(--bb-chrome)", border: "var(--chrome-border)", text: "#fff", icon: "ℹ" },
  success: { bg: "var(--bb-green)", border: "var(--bb-green)", text: "#000", icon: "✓" },
  warning: { bg: "var(--bb-amber-bg)", border: "var(--bb-amber-bg)", text: "#000", icon: "⚠" },
  error: { bg: "var(--bb-red)", border: "var(--bb-red)", text: "#fff", icon: "✕" },
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
        borderRadius: 0,
        padding: "8px 12px",
        minWidth: 280,
        maxWidth: 380,
        boxShadow: "none",
      }}
    >
      <span style={{ fontSize: 14, marginTop: 1, color: style.text }}>{style.icon}</span>
      <span style={{ fontSize: 12, color: style.text, flex: 1 }}>
        {toast.message}
      </span>
      <button
        onClick={() => dismissToast(toast.id)}
        style={{
          background: "none",
          border: "none",
          color: style.text,
          opacity: 0.7,
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
