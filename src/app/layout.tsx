import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "MarketMap",
  description: "Equity market mapping and portfolio analytics",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="appBody">
        {children}
      </body>
    </html>
  );
}
