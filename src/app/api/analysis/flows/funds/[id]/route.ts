import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { requireAdminGuard } from "@/lib/api/guards";
import { flowsFundPatchBody } from "@/lib/api/schemas";
import { deleteFund, updateFund } from "@/server/services/institutional/institutional-query.service";

export const maxDuration = 30;

/** Map a Prisma "record not found" (P2025) to a 404; everything else to 500. */
function fail(action: string, e: unknown): NextResponse {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
    return NextResponse.json({ error: "NOT_FOUND", reason: "No such fund." }, { status: 404 });
  }
  return NextResponse.json({ error: `${action}_FAILED`, reason: e instanceof Error ? e.message : String(e) }, { status: 500 });
}

/** Edit a watchlist fund (tier, name, isActive, isMostRespected, notes). Admin. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminGuard(req);
  if (guard) return guard;
  const { id } = await ctx.params;
  const parsed = flowsFundPatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    await updateFund(id, parsed.data);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail("UPDATE", e);
  }
}

/** Remove a fund from the watchlist (admin). Cascades its snapshots. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminGuard(req);
  if (guard) return guard;
  const { id } = await ctx.params;
  try {
    await deleteFund(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail("DELETE", e);
  }
}
