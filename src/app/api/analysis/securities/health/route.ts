import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import {
  confirmDelist,
  listDelistCandidates,
  listDelistedSecurities,
  markLive,
  reactivateSecurity,
  refreshSuccessorSuggestions,
} from "@/server/services/security-health.service";
import { requireAdminGuard } from "@/lib/api/guards";

export const dynamic = "force-dynamic";

export async function GET() {
  // Refresh successor hints opportunistically — only candidates without one
  // get a Yahoo lookup, so the cost is bounded by the candidate list.
  await refreshSuccessorSuggestions(prisma).catch(() => null);
  const [candidates, delisted] = await Promise.all([
    listDelistCandidates(prisma),
    listDelistedSecurities(prisma),
  ]);
  return NextResponse.json({ candidates, delisted });
}

type Action = "confirm-delist" | "mark-live" | "reactivate";

export async function POST(req: Request) {
  const adminGuard = await requireAdminGuard(req);
  if (adminGuard) return adminGuard;
  let body: { action?: Action; securityId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { action, securityId } = body;
  if (!action || !securityId) {
    return NextResponse.json(
      { error: "action and securityId are required" },
      { status: 400 }
    );
  }
  try {
    if (action === "confirm-delist") {
      await confirmDelist(prisma, securityId);
    } else if (action === "mark-live") {
      await markLive(prisma, securityId);
    } else if (action === "reactivate") {
      await reactivateSecurity(prisma, securityId);
    } else {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
