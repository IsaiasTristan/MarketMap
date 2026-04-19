import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { saveConstituentsBody } from "@/lib/api/schemas";
import {
  removeUniverseConstituent,
  replaceUniverseConstituents,
} from "@/server/services/universe.service";

// Replacing a multi-thousand-ticker universe touches 5+ batched queries
// inside one Postgres transaction. Allow plenty of headroom over the default
// serverless cap so a 1k-row paste never gets killed mid-write.
export const maxDuration = 120;
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  const parsed = saveConstituentsBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, errors: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const exists = await prisma.universe.findUnique({ where: { id } });
  if (!exists)
    return NextResponse.json(
      { ok: false, error: "Universe not found" },
      { status: 404 }
    );

  try {
    const result = await replaceUniverseConstituents(
      prisma,
      id,
      parsed.data.rows
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[constituents.POST] replace failed", { universeId: id, message });
    return NextResponse.json(
      { ok: false, error: `Failed to save tickers: ${message}` },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ticker = new URL(req.url).searchParams.get("ticker")?.trim();
  if (!ticker) {
    return NextResponse.json(
      { ok: false, error: "Missing ticker query parameter" },
      { status: 400 }
    );
  }
  const exists = await prisma.universe.findUnique({ where: { id } });
  if (!exists) return NextResponse.json({ error: "Universe not found" }, { status: 404 });

  const removed = await removeUniverseConstituent(prisma, id, ticker);
  if (!removed) {
    return NextResponse.json(
      { ok: false, error: `Ticker ${ticker.toUpperCase()} not in universe` },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true });
}
