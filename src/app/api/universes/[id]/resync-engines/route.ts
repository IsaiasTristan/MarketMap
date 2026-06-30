import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { requireAdminGuard } from "@/lib/api/guards";
import { withIngestLock } from "@/server/services/ingest-inflight";
import {
  getEngineResyncState,
  runEngineResync,
} from "@/server/services/engine-resync.service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Kick off a background resync of the downstream engines (RevisionReference +
 * Research/Fundamentals re-score) after a market-map taxonomy change. Returns
 * immediately; the work continues in-process and is observable via GET.
 */
export async function POST(req: Request, ctx: Ctx) {
  const adminGuard = await requireAdminGuard(req);
  if (adminGuard) return adminGuard;
  const { id } = await ctx.params;

  const exists = await prisma.universe.findUnique({ where: { id } });
  if (!exists) {
    return NextResponse.json({ error: "Universe not found" }, { status: 404 });
  }

  if (getEngineResyncState().status === "running") {
    return NextResponse.json({ started: false, reason: "already-running" });
  }

  // Fire-and-forget: withIngestLock dedupes concurrent triggers; runEngineResync
  // sets status to "running" synchronously before its first await, so a follow-up
  // POST sees "already-running". We intentionally do not await the run.
  void withIngestLock("engines:resync", () =>
    runEngineResync({ universeId: id }),
  );

  return NextResponse.json({ started: true });
}

/** Current resync status for the modal to poll. */
export async function GET(req: Request) {
  const adminGuard = await requireAdminGuard(req);
  if (adminGuard) return adminGuard;
  return NextResponse.json(getEngineResyncState());
}
