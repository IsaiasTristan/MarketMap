import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import {
  getPortfolio,
  deletePortfolio,
  renamePortfolio,
} from "@/server/services/portfolio.service";
import { renamePortfolioBody } from "@/lib/api/schemas";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const p = await getPortfolio(prisma, id);
  if (!p) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ portfolio: p });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  const parsed = renamePortfolioBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, errors: parsed.error.flatten() },
      { status: 400 }
    );
  }
  try {
    await renamePortfolio(prisma, id, parsed.data.name);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    await deletePortfolio(prisma, id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
