"use client";
import { useRouter } from "next/navigation";
import { useAnalysisStore } from "@/store/analysis";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

export default function WelcomePage() {
  const router = useRouter();
  const { setActivePortfolio } = useAnalysisStore();
  const [loadingDemo, setLoadingDemo] = useState(false);

  const { data: portfolios = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["portfolios-list"],
    queryFn: () => fetch("/api/analysis/portfolios").then((r) => r.json()),
  });

  const handleSelectPortfolio = (id: string) => {
    setActivePortfolio(id);
    router.push("/overview");
  };

  const handleDemo = async () => {
    setLoadingDemo(true);
    try {
      const r = await fetch("/api/analysis/portfolio/demo", { method: "POST" });
      const d = await r.json();
      setActivePortfolio(d.portfolioId);
      router.push("/overview");
    } finally {
      setLoadingDemo(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "calc(100vh - 56px)",
        gap: 48,
        padding: 40,
      }}
    >
      {/* Hero */}
      <div style={{ textAlign: "center", maxWidth: 560 }}>
        <div
          style={{
            fontSize: 48,
            marginBottom: 16,
            color: "var(--color-accent)",
          }}
        >
          ◈
        </div>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 700,
            color: "var(--text-primary)",
            margin: "0 0 12px",
          }}
        >
          Portfolio Analysis Suite
        </h1>
        <p
          style={{
            fontSize: 15,
            color: "var(--text-secondary)",
            lineHeight: 1.6,
            margin: 0,
          }}
        >
          Institutional-grade risk analytics, factor exposure, performance
          attribution, and stress testing — built for individual investors.
        </p>
      </div>

      {/* Action cards */}
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", justifyContent: "center" }}>
        {/* Upload card */}
        <a
          href="/data"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            padding: "32px 40px",
            background: "var(--bg-surface)",
            border: "1px solid var(--bg-border)",
            borderRadius: 16,
            textDecoration: "none",
            color: "var(--text-primary)",
            cursor: "pointer",
            minWidth: 200,
            transition: "border-color 0.15s",
          }}
        >
          <span style={{ fontSize: 32 }}>⊞</span>
          <span style={{ fontSize: 16, fontWeight: 600 }}>Upload Portfolio</span>
          <span style={{ fontSize: 12, color: "var(--text-secondary)", textAlign: "center" }}>
            Import CSV with positions, shares, and entry prices
          </span>
        </a>

        {/* Demo card */}
        <button
          onClick={handleDemo}
          disabled={loadingDemo}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            padding: "32px 40px",
            background: "var(--bg-surface)",
            border: "1px solid var(--color-accent)",
            borderRadius: 16,
            color: "var(--text-primary)",
            cursor: "pointer",
            minWidth: 200,
          }}
        >
          <span style={{ fontSize: 32 }}>▶</span>
          <span style={{ fontSize: 16, fontWeight: 600 }}>
            {loadingDemo ? "Loading…" : "Try Demo Portfolio"}
          </span>
          <span style={{ fontSize: 12, color: "var(--text-secondary)", textAlign: "center" }}>
            15 diversified positions across sectors
          </span>
        </button>
      </div>

      {/* Existing portfolios */}
      {portfolios.length > 0 && (
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              marginBottom: 12,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Or open an existing portfolio
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            {portfolios.map((p) => (
              <button
                key={p.id}
                onClick={() => handleSelectPortfolio(p.id)}
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "1px solid var(--bg-border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
