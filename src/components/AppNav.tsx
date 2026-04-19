import type { CSSProperties } from "react";
import Link from "next/link";

const linkStyle: CSSProperties = {
  marginRight: "1.25rem",
  color: "#c7d0dc",
  textDecoration: "none",
  fontWeight: 500,
};

const brandStyle: CSSProperties = {
  ...linkStyle,
  color: "#f2f5f9",
  fontWeight: 700,
};

export function AppNav() {
  return (
    <header
      style={{
        borderBottom: "1px solid #1e2636",
        background: "#0b1018",
        padding: "0.75rem 1.5rem",
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
      }}
    >
      <Link href="/market-map" style={brandStyle}>
        MarketMap
      </Link>
      <nav style={{ display: "flex", flexWrap: "wrap" }}>
        <Link href="/market-map" style={linkStyle}>
          Performance
        </Link>
        <Link href="/portfolios" style={linkStyle}>
          Portfolios
        </Link>
      </nav>
    </header>
  );
}
