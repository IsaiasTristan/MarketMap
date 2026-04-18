import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { createUniverseBody } from "@/lib/api/schemas";
import { createPortfolio, listPortfolios } from "@/server/services/portfolio.service";

export async function GET() {
  const list = await listPortfolios(prisma);
  return NextResponse.json({ portfolios: list });
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
  const p = await createPortfolio(prisma, parsed.data.name);
  return NextResponse.json({ ok: true, id: p.id });
}
