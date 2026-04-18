import { Suspense } from "react";
import { MarketMapPageInner } from "./MarketMapPageInner";

export default function MarketMapPage() {
  return (
    <Suspense
      fallback={
        <p style={{ padding: "1.5rem", color: "#4a5a6b" }}>Loading market map…</p>
      }
    >
      <MarketMapPageInner />
    </Suspense>
  );
}
