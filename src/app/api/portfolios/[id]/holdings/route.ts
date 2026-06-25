import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { portfolioPositionsBody } from "@/lib/api/schemas";
import { replacePositions } from "@/server/services/position.service";
import { requirePortfolioAccess } from "@/lib/api/guards";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PUT /api/portfolios/[id]/holdings
 *
 * Replaces a portfolio's positions in one shot. The route name is kept for
 * backwards compatibility with bookmarks and the existing client code; the
 * payload now uses the simplified position model (ticker / shares /
 * isShort / sector).
 */
export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const guard = await requirePortfolioAccess(req, id);
  if (guard) return guard;
  const json = await req.json().catch(() => null);
  const parsed = portfolioPositionsBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, errors: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const exists = await prisma.portfolio.findUnique({ where: { id } });
  if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    // The payload schema allows `sector: null` (to clear it), but PositionInput
    // uses `string | undefined`; normalize null -> undefined at the boundary.
    const positions = parsed.data.positions
      .filter(
        (p): p is typeof p & { ticker: string; shares: number } =>
          !p.isCash && !!p.ticker && p.shares != null,
      )
      .map((p) => ({
        ticker: p.ticker,
        shares: p.shares,
        isShort: p.isShort,
        sector: p.sector ?? undefined,
      }));
    await replacePositions(id, positions);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
