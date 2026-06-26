import { NextResponse } from "next/server";
import { prisma as db } from "@/infrastructure/db/client";
import { requirePortfolioAccess, resolveUserOrResponse } from "@/lib/api/guards";
import { duplicatePortfolio } from "@/server/services/portfolio.service";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const guard = await requirePortfolioAccess(req, id);
  if (guard) return guard;
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;

  const source = await db.portfolio.findUnique({
    where: { id },
    select: { name: true },
  });
  if (!source) {
    return NextResponse.json({ error: "Portfolio not found" }, { status: 404 });
  }

  const copyName = `${source.name} (copy)`.slice(0, 100);
  const result = await duplicatePortfolio(db, id, auth.user.id, copyName);
  return NextResponse.json({ id: result.id, name: result.name });
}
