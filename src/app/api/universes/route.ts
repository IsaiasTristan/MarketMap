import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { createUniverseBody } from "@/lib/api/schemas";
import { createUniverse } from "@/server/services/universe.service";

export async function GET() {
  const list = await prisma.universe.findMany({
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { constituents: true } } },
  });
  return NextResponse.json({ universes: list });
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = createUniverseBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, errors: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { id } = await createUniverse(prisma, parsed.data.name);
  return NextResponse.json({ ok: true, id });
}
