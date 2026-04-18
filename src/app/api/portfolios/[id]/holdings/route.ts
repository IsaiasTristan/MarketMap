import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { portfolioHoldingsBody } from "@/lib/api/schemas";
import { replaceHoldings } from "@/server/services/portfolio.service";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  const parsed = portfolioHoldingsBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, errors: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const exists = await prisma.portfolio.findUnique({ where: { id } });
  if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await replaceHoldings(prisma, id, parsed.data.holdings);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
