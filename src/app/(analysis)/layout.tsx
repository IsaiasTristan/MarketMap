import type { ReactNode } from "react";
import { AnalysisProviders } from "@/components/analysis/providers";
import { TopBar } from "@/components/analysis/TopBar";
import { ToastContainer } from "@/components/analysis/ui/Toast";
import "./analysis.css";

export default function AnalysisLayout({ children }: { children: ReactNode }) {
  const monoStack = "\"Andale Mono\", \"Consolas\", \"Liberation Mono\", \"Courier New\", monospace";
  return (
    <div
      className="analysis-shell"
      style={{
        display: "flex",
        minHeight: "100vh",
        ["--font-sans" as string]: monoStack,
        ["--font-mono" as string]: monoStack,
      }}
    >
      <AnalysisProviders>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <TopBar />
          <main style={{ flex: 1, padding: "4px", overflowY: "auto" }}>
            {children}
          </main>
        </div>
        <ToastContainer />
      </AnalysisProviders>
    </div>
  );
}
