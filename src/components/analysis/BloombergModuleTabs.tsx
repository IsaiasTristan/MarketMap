"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const MODULE_TABS = [
  { href: "/market-map", label: "Market Map" },
  { href: "/overview", label: "Overview" },
  { href: "/performance", label: "Performance" },
  { href: "/risk", label: "Risk" },
  { href: "/factors", label: "Factors" },
  { href: "/data", label: "Data" },
  { href: "/alerts", label: "Alerts" },
] as const;

export function isModulePathActive(pathname: string, href: string): boolean {
  if (href === "/market-map") {
    return pathname === "/market-map" || pathname === "/" || pathname === "/welcome";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function pageTitleFromPath(pathname: string): string {
  const tab = MODULE_TABS.find((t) => isModulePathActive(pathname, t.href));
  return (tab?.label ?? "Market Map").toUpperCase();
}

export function BloombergModuleTabs() {
  const pathname = usePathname() ?? "";

  return (
    <nav className="bb-tab-row" aria-label="Main modules">
      {MODULE_TABS.map((t) => {
        const active = isModulePathActive(pathname, t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`bb-tab${active ? " bb-tab--active" : ""}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
