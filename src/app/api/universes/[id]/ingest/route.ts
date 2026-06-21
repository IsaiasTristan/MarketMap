import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import {
  ingestUniverseSecurities,
  refreshUniverseTail,
} from "@/server/services/ingest-universe.service";
import { requireAdminGuard } from "@/lib/api/guards";

// Yahoo throttling forces us to ingest sequentially with backoff; a fresh
// universe of ~400 tickers can take several minutes. Tell Next.js not to
// kill the route handler at the default 5-minute boundary.
export const maxDuration = 600;
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

type Mode = "missing" | "tail" | "all";

function resolveMode(url: URL): Mode {
  const m = url.searchParams.get("mode");
  if (m === "missing" || m === "tail" || m === "all") return m;
  // Backward-compat: legacy `?onlyMissing=true` → mode=missing.
  if (url.searchParams.get("onlyMissing") === "true") return "missing";
  return "all";
}

export async function POST(req: Request, ctx: Ctx) {
  const adminGuard = await requireAdminGuard(req);
  if (adminGuard) return adminGuard;
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const mode = resolveMode(url);
  const tailDays = Math.max(
    1,
    Number(url.searchParams.get("days") ?? "") || 10
  );

  const exists = await prisma.universe.findUnique({ where: { id } });
  if (!exists)
    return NextResponse.json({ error: "Universe not found" }, { status: 404 });

  try {
    if (mode === "tail") {
      const r = await refreshUniverseTail(prisma, id, tailDays);
      return NextResponse.json({ ok: true, mode, tailDays, ...r });
    }
    const r = await ingestUniverseSecurities(prisma, id, 10, {
      onlyMissing: mode === "missing",
    });
    return NextResponse.json({ ok: true, mode, ...r });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
