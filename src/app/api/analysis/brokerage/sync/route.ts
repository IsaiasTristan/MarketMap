import { NextResponse } from "next/server";
import { prisma as db } from "@/infrastructure/db/client";
import { resolveAdminOrResponse } from "@/lib/api/guards";
import { snaptradeConfigured } from "@/infrastructure/config/env";
import { discoverAndLinkAccounts } from "@/server/services/brokerage/snaptrade-link.service";
import { syncBrokerageAccount } from "@/server/services/brokerage/snaptrade-sync.service";

// Onboarding a fresh account may ingest 10y of history per new ticker.
export const maxDuration = 300;

/**
 * POST /api/analysis/brokerage/sync
 * Manual "Sync now". With no body, discovers accounts and syncs all of the
 * user's managed accounts. With { accountLinkId }, syncs that one account
 * (scoped to the current user). Bypasses the post-close runner gate.
 */
export async function POST(req: Request) {
  if (!snaptradeConfigured()) {
    return NextResponse.json(
      { error: "Brokerage linking is not configured on this server." },
      { status: 501 },
    );
  }
  const auth = await resolveAdminOrResponse(req);
  if ("response" in auth) return auth.response;

  const body = await req.json().catch(() => ({}));
  const accountLinkId = typeof body?.accountLinkId === "string" ? body.accountLinkId : null;

  try {
    if (accountLinkId) {
      // Scope the account to the current user before syncing.
      const link = await db.brokerageAccountLink.findUnique({
        where: { id: accountLinkId },
        include: { brokerageLink: { select: { userId: true } } },
      });
      if (!link || link.brokerageLink.userId !== auth.user.id) {
        return NextResponse.json({ error: "Account not found." }, { status: 404 });
      }
      const result = await syncBrokerageAccount(accountLinkId);
      return NextResponse.json({ results: [{ accountLinkId, ...result }] });
    }

    const discovered = await discoverAndLinkAccounts(auth.user.id);
    const results = [];
    for (const acct of discovered) {
      const result = await syncBrokerageAccount(acct.accountLinkId);
      results.push({ accountLinkId: acct.accountLinkId, ...result });
    }
    return NextResponse.json({ results });
  } catch (e) {
    console.error("POST /api/analysis/brokerage/sync failed:", e);
    return NextResponse.json(
      { error: (e as Error).message ?? "Failed to sync brokerage account" },
      { status: 502 },
    );
  }
}
