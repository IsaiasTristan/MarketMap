import { NextResponse } from "next/server";
import { prisma as db } from "@/infrastructure/db/client";
import { resolveAdminOrResponse } from "@/lib/api/guards";
import { snaptradeConfigured } from "@/infrastructure/config/env";
import type { SkippedPosition } from "@/lib/brokerage/snaptrade-positions";

/**
 * GET /api/analysis/brokerage/status
 * Returns the current user's brokerage link + managed accounts, so the Data
 * tab can show connection state, per-account sync status, and skipped
 * instruments. `configured` tells the UI whether to offer the Connect button.
 */
export async function GET(req: Request) {
  const auth = await resolveAdminOrResponse(req);
  if ("response" in auth) return auth.response;

  const link = await db.brokerageLink.findUnique({
    where: { userId: auth.user.id },
    include: {
      accounts: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const accounts = (link?.accounts ?? []).map((a) => ({
    id: a.id,
    portfolioId: a.portfolioId,
    institutionName: a.institutionName,
    accountMask: a.accountMask,
    lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: a.lastSyncStatus,
    lastSyncError: a.lastSyncError,
    positionCount: a.positionCount,
    skipped: (a.skippedJson as unknown as SkippedPosition[] | null) ?? [],
  }));

  return NextResponse.json({
    configured: snaptradeConfigured(),
    linked: !!link,
    accounts,
  });
}
