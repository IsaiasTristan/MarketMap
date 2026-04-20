import { NextResponse } from "next/server";
import { prisma as db } from "@/infrastructure/db/client";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  const date = searchParams.get("date"); // YYYY-MM-DD

  if (!ticker || !date) {
    return NextResponse.json({ error: "ticker and date required" }, { status: 400 });
  }

  const cutoff = new Date(date);

  // Check if this ticker is a benchmark proxy ticker first.
  const benchmark = await db.benchmark.findFirst({
    where: { proxyTicker: { equals: ticker, mode: "insensitive" } },
    select: { id: true },
  });

  if (benchmark) {
    const row = await db.benchmarkPriceHistory.findFirst({
      where: {
        benchmarkId: benchmark.id,
        tradeDate: { lte: cutoff },
      },
      orderBy: { tradeDate: "desc" },
      select: { adjClose: true, tradeDate: true },
    });

    if (!row) {
      return NextResponse.json(
        { error: `No price data for ${ticker} on or before ${date}` },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ticker,
      date: row.tradeDate.toISOString().slice(0, 10),
      price: Number(row.adjClose),
    });
  }

  // Fall back to regular security price history.
  const security = await db.security.findUnique({
    where: { ticker },
    select: { id: true },
  });
  if (!security) {
    return NextResponse.json({ error: `Unknown ticker: ${ticker}` }, { status: 404 });
  }

  const row = await db.priceHistory.findFirst({
    where: {
      securityId: security.id,
      tradeDate: { lte: cutoff },
    },
    orderBy: { tradeDate: "desc" },
    select: { adjClose: true, tradeDate: true },
  });

  if (!row) {
    return NextResponse.json(
      { error: `No price data for ${ticker} on or before ${date}` },
      { status: 404 },
    );
  }

  return NextResponse.json({
    ticker,
    date: row.tradeDate.toISOString().slice(0, 10),
    price: Number(row.adjClose),
  });
}
