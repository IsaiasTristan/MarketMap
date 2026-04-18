import type { CSSProperties } from "react";
import Link from "next/link";

const linkStyle: CSSProperties = {
  marginRight: "1.25rem",
  color: "#1a3a5c",
  textDecoration: "none",
  fontWeight: 500,
};

export function AppNav() {
  return (
    <header
      style={{
        borderBottom: "1px solid #cfd6e0",
        background: "#fff",
        padding: "0.75rem 1.5rem",
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
      }}
    >
      <Link href="/" style={{ ...linkStyle, fontWeight: 700 }}>
        MarketMap
      </Link>
      <nav style={{ display: "flex", flexWrap: "wrap" }}>
        <Link href="/universe" style={linkStyle}>
          Universe
        </Link>
        <Link href="/market-map" style={linkStyle}>
          Market map
        </Link>
        <Link href="/portfolios" style={linkStyle}>
          Portfolios
        </Link>
      </nav>
    </header>
  );
}
