"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { MarketMapClient } from "@/components/MarketMapClient";
import type { RowLevel } from "@/domain/entities/analytics";

export function MarketMapPageInner() {
  const sp = useSearchParams();
  const universeId = sp.get("universeId");
  const sector = sp.get("sector") ?? undefined;
  const subTheme = sp.get("subTheme") ?? undefined;
  const rowLevelRaw = sp.get("rowLevel");
  const rowLevelParam: RowLevel | undefined =
    rowLevelRaw === "SECTOR" ||
    rowLevelRaw === "SUB_THEME" ||
    rowLevelRaw === "COMPANY"
      ? rowLevelRaw
      : undefined;

  const [universes, setUniverses] = useState<
    { id: string; name: string; _count: { constituents: number } }[]
  >([]);

  useEffect(() => {
    void fetch("/api/universes", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setUniverses(j.universes ?? []))
      .catch(() => setUniverses([]));
  }, []);

  if (!universeId) {
    return (
      <div style={{ maxWidth: 720, padding: "1.5rem" }}>
        <h1 style={{ fontSize: "1.35rem" }}>Market map</h1>
        <p style={{ color: "#4a5a6b" }}>
          Select a universe. Create one on the Universe page if needed.
        </p>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {universes.map((u) => (
            <li key={u.id} style={{ marginBottom: "0.5rem" }}>
              <a
                href={`/market-map?universeId=${u.id}`}
                style={{ color: "#1a3a5c", fontWeight: 600 }}
              >
                {u.name}
              </a>
              <span style={{ color: "#6a7a8b", marginLeft: "0.5rem" }}>
                ({u._count.constituents} names)
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div style={{ padding: "1.5rem", maxWidth: 1400, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.35rem", marginBottom: "0.5rem" }}>Market map</h1>
      <p style={{ color: "#4a5a6b", fontSize: "0.9rem", marginBottom: "1rem" }}>
        As-of dates follow each security&apos;s latest stored bar; excess return
        aligns on common trading dates with the benchmark.
      </p>
      <MarketMapClient
        universeId={universeId}
        initialSector={sector}
        initialSubTheme={subTheme}
        initialRowLevel={rowLevelParam}
      />
    </div>
  );
}
