import { NextResponse } from "next/server";
import { prisma as db } from "@/infrastructure/db/client";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim().toUpperCase();

  if (q.length < 1) return NextResponse.json([]);

  const [securities, benchmarks] = await Promise.all([
    db.security.findMany({
      where: {
        isActive: true,
        OR: [
          { ticker: { startsWith: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { ticker: true, name: true, sector: true },
      orderBy: [{ ticker: "asc" }],
      take: 10,
    }),
    db.benchmark.findMany({
      where: {
        OR: [
          { proxyTicker: { contains: q, mode: "insensitive" } },
          { displayName: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { proxyTicker: true, displayName: true },
    }),
  ]);

  const benchmarkResults = benchmarks.map((b) => ({
    ticker: b.proxyTicker,
    name: b.displayName,
    sector: null,
    isBenchmark: true,
  }));

  const securityResults = securities.map((s) => ({
    ...s,
    isBenchmark: false,
  }));

  // Benchmarks first, then securities, capped at 12 total
  const combined = [...benchmarkResults, ...securityResults].slice(0, 12);

  return NextResponse.json(combined);
}
