import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AnalysisProviders } from "@/components/analysis/providers";
import { Sidebar } from "@/components/analysis/Sidebar";
import { TopBar } from "@/components/analysis/TopBar";
import { ToastContainer } from "@/components/analysis/ui/Toast";
import "./analysis.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export default function AnalysisLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${inter.variable} ${jetbrainsMono.variable} analysis-shell`}
      style={{ display: "flex", minHeight: "100vh" }}
    >
      <AnalysisProviders>
        <Sidebar />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <TopBar />
          <main style={{ flex: 1, padding: 24, overflowY: "auto" }}>
            {children}
          </main>
        </div>
        <ToastContainer />
      </AnalysisProviders>
    </div>
  );
}
