"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  group?: string;
}

const NAV: NavItem[] = [
  { href: "/market-map", label: "Market Map", icon: "⊟", group: "Portfolio" },
  { href: "/overview", label: "Overview", icon: "◈", group: "Portfolio" },
  { href: "/performance", label: "Performance", icon: "▲", group: "Analysis" },
  { href: "/risk", label: "Risk", icon: "⚡", group: "Analysis" },
  { href: "/factors", label: "Factor Analysis", icon: "∑", group: "Analysis" },
  { href: "/stress", label: "Stress Test", icon: "⚑", group: "Analysis" },
  { href: "/concentration", label: "Concentration", icon: "⊕", group: "Reporting" },
  { href: "/data", label: "Data Management", icon: "⊞", group: "Settings" },
  { href: "/alerts", label: "Alerts", icon: "⚠", group: "Settings" },
];

const GROUPS = ["Portfolio", "Analysis", "Reporting", "Settings"];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      style={{
        width: 240,
        minHeight: "100vh",
        background: "var(--bg-surface)",
        borderRight: "1px solid var(--bg-border)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        position: "sticky",
        top: 0,
        height: "100vh",
        overflowY: "auto",
      }}
    >
      {/* Logo */}
      <div
        style={{
          padding: "20px 20px 12px",
          borderBottom: "1px solid var(--bg-border)",
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: "var(--color-accent)",
            letterSpacing: "0.02em",
          }}
        >
          MarketMap
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
          Portfolio Analysis
        </div>
      </div>

      {/* Nav groups */}
      <nav style={{ flex: 1, padding: "12px 8px" }}>
        {GROUPS.map((group) => {
          const items = NAV.filter((n) => n.group === group);
          return (
            <div key={group} style={{ marginBottom: 20 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  padding: "0 12px",
                  marginBottom: 4,
                }}
              >
                {group}
              </div>
              {items.map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 8,
                      textDecoration: "none",
                      fontSize: 13,
                      fontWeight: active ? 600 : 400,
                      color: active
                        ? "var(--color-accent)"
                        : "var(--text-secondary)",
                      background: active ? "var(--bg-elevated)" : "transparent",
                      borderLeft: active
                        ? "3px solid var(--color-accent)"
                        : "3px solid transparent",
                      marginBottom: 2,
                      transition: "all 0.15s",
                    }}
                  >
                    <span style={{ fontSize: 14, width: 18, textAlign: "center" }}>
                      {item.icon}
                    </span>
                    {item.label}
                  </Link>
                );
              })}
              {group === "Reporting" && (
                <div
                  style={{
                    height: 1,
                    background: "var(--bg-border)",
                    margin: "12px 12px 0",
                  }}
                />
              )}
            </div>
          );
        })}
      </nav>

    </aside>
  );
}
