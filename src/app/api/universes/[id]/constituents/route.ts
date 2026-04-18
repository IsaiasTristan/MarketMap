import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { saveConstituentsBody } from "@/lib/api/schemas";
import { replaceUniverseConstituents } from "@/server/services/universe.service";

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
  if (!exists) return NextResponse.json({ error: "Universe not found" }, { status: 404 });

  await replaceUniverseConstituents(prisma, id, parsed.data.rows);
  return NextResponse.json({ ok: true });
}
