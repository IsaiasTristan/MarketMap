import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const u = await prisma.universe.findUnique({
    where: { id },
    include: {
      constituents: {
        orderBy: { sortOrder: "asc" },
        include: { security: true },
      },
    },
  });
  if (!u) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ universe: u });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    await prisma.universe.delete({ where: { id } });
    // MarketMapSnapshot has no FK to Universe — drop the cached grids too so
    // they don't linger as orphans (invalidation only marks rows stale now).
    await prisma.marketMapSnapshot.deleteMany({ where: { universeId: id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
