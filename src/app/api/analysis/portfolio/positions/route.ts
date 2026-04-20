import { NextResponse } from "next/server";
import {
  getPositions,
  addPosition,
  deletePosition,
  updatePosition,
} from "@/server/services/position.service";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId) return NextResponse.json({ error: "portfolioId required" }, { status: 400 });

  const positions = await getPositions(portfolioId);
  return NextResponse.json(positions);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { portfolioId, ticker, shares, entryPrice, entryDate, sector, currency, notes } = body;

  if (!portfolioId || !ticker || !shares || !entryPrice || !entryDate) {
    return NextResponse.json({ error: "portfolioId, ticker, shares, entryPrice, entryDate required" }, { status: 400 });
  }

  const id = await addPosition(portfolioId, {
    ticker: String(ticker).toUpperCase(),
    shares: Number(shares),
    entryPrice: Number(entryPrice),
    entryDate: String(entryDate),
    sector: sector ? String(sector) : undefined,
    currency: currency ? String(currency) : "USD",
    notes: notes ? String(notes) : undefined,
  });

  return NextResponse.json({ id });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await deletePosition(id);
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const { shares, entryPrice, entryDate, sector, currency, notes } = body;
  const input: Record<string, unknown> = {};
  if (shares !== undefined) input.shares = Number(shares);
  if (entryPrice !== undefined) input.entryPrice = Number(entryPrice);
  if (entryDate !== undefined) input.entryDate = String(entryDate);
  if (sector !== undefined) input.sector = sector ?? null;
  if (currency !== undefined) input.currency = String(currency);
  if (notes !== undefined) input.notes = notes ?? null;
  await updatePosition(id, input as Parameters<typeof updatePosition>[1]);
  return NextResponse.json({ ok: true });
}
