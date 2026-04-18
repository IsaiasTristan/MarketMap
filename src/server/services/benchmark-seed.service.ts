import type { PrismaClient } from "@prisma/client";

const ROWS = [
  {
    code: "SP500" as const,
    displayName: "S&P 500",
    proxyTicker: "^GSPC",
  },
  {
    code: "NASDAQ" as const,
    displayName: "NASDAQ Composite",
    proxyTicker: "^IXIC",
  },
  {
    code: "DOW" as const,
    displayName: "Dow Jones Industrial Average",
    proxyTicker: "^DJI",
  },
];

export async function ensureBenchmarksSeeded(db: PrismaClient): Promise<void> {
  for (const r of ROWS) {
    await db.benchmark.upsert({
      where: { code: r.code },
      create: r,
      update: { displayName: r.displayName, proxyTicker: r.proxyTicker },
    });
  }
}
