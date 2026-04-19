import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { ingestUniverseSecurities } from "@/server/services/ingest-universe.service";

// Yahoo throttling forces us to ingest sequentially with backoff; a fresh
// universe of ~400 tickers can take several minutes. Tell Next.js not to
// kill the route handler at the default 5-minute boundary.
export const maxDuration = 600;
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const onlyMissing = url.searchParams.get("onlyMissing") === "true";
  const exists = await prisma.universe.findUnique({ where: { id } });
  if (!exists) return NextResponse.json({ error: "Universe not found" }, { status: 404 });
  try {
    const r = await ingestUniverseSecurities(prisma, id, 10, { onlyMissing });
    return NextResponse.json({ ok: true, onlyMissing, ...r });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
