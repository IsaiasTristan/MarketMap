import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { ingestUniverseSecurities } from "@/server/services/ingest-universe.service";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const exists = await prisma.universe.findUnique({ where: { id } });
  if (!exists) return NextResponse.json({ error: "Universe not found" }, { status: 404 });
  try {
    const r = await ingestUniverseSecurities(prisma, id, 10);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
