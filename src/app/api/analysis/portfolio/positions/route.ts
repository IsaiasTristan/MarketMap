import { NextResponse } from "next/server";
import {
  getPositions,
  addPosition,
  deletePosition,
  updatePosition,
  replacePositions,
  type PositionInput,
} from "@/server/services/position.service";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId) return NextResponse.json({ error: "portfolioId required" }, { status: 400 });

  const positions = await getPositions(portfolioId);
  return NextResponse.json(positions);
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { portfolioId, ticker, shares, isShort, sector, replace, positions } = body;

    if (!portfolioId) {
      return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
    }

    // Bulk replace mode (used by the editor's "Save" button).
    if (replace && Array.isArray(positions)) {
      const inputs: PositionInput[] = positions.map((p) => ({
        ticker: String(p.ticker).toUpperCase(),
        shares: Number(p.shares),
        isShort: Boolean(p.isShort),
        sector: p.sector ? String(p.sector) : undefined,
      }));
      await replacePositions(portfolioId, inputs);
      return NextResponse.json({ ok: true, count: inputs.length });
    }

    // Single-position add (legacy path used by the inline "Add ticker" form).
    if (!ticker || !shares) {
      return NextResponse.json({ error: "ticker and shares required" }, { status: 400 });
    }

    const id = await addPosition(portfolioId, {
      ticker: String(ticker).toUpperCase(),
      shares: Number(shares),
      isShort: Boolean(isShort),
      sector: sector ? String(sector) : undefined,
    });

    return NextResponse.json({ id });
  } catch (e) {
    console.error("POST /api/analysis/portfolio/positions failed:", e);
    return NextResponse.json(
      { error: (e as Error).message ?? "Failed to add position" },
      { status: 500 },
    );
  }
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
  const { shares, isShort, sector } = body;
  const input: Parameters<typeof updatePosition>[1] = {};
  if (shares !== undefined) input.shares = Number(shares);
  if (isShort !== undefined) input.isShort = Boolean(isShort);
  if (sector !== undefined) input.sector = sector ?? null;
  await updatePosition(id, input);
  return NextResponse.json({ ok: true });
}
