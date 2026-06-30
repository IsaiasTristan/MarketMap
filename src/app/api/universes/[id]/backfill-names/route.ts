import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { backfillUniverseConstituentNames } from "@/server/services/security-name.service";
import { requireAdminGuard } from "@/lib/api/guards";

// A large first-time universe can resolve many names via FMP/Yahoo; give the
// worker pool plenty of headroom over the default serverless cap.
export const maxDuration = 120;
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const adminGuard = await requireAdminGuard(req);
  if (adminGuard) return adminGuard;
  const { id } = await ctx.params;

  const exists = await prisma.universe.findUnique({ where: { id } });
  if (!exists)
    return NextResponse.json(
      { ok: false, error: "Universe not found" },
      { status: 404 }
    );

  try {
    const result = await backfillUniverseConstituentNames(prisma, id);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[backfill-names.POST] failed", { universeId: id, message });
    return NextResponse.json(
      { ok: false, error: `Failed to backfill names: ${message}` },
      { status: 500 }
    );
  }
}
