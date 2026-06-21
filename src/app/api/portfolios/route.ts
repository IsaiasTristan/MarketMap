import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { createUniverseBody } from "@/lib/api/schemas";
import { createPortfolio, listPortfolios } from "@/server/services/portfolio.service";
import { resolveUserOrResponse } from "@/lib/api/guards";

export async function GET(req: Request) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const list = await listPortfolios(prisma, auth.user.id);
  return NextResponse.json({ portfolios: list });
}

export async function POST(req: Request) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const json = await req.json().catch(() => null);
  const parsed = createUniverseBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, errors: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const p = await createPortfolio(prisma, parsed.data.name, auth.user.id);
  return NextResponse.json({ ok: true, id: p.id });
}
