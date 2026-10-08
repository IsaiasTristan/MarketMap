import { NextResponse } from "next/server";
import { resolveAdminOrResponse } from "@/lib/api/guards";
import { snaptradeConfigured } from "@/infrastructure/config/env";
import { disconnectAccount } from "@/server/services/brokerage/snaptrade-link.service";

/**
 * POST /api/analysis/brokerage/disconnect { accountLinkId }
 * Removes a managed-account link (scoped to the current user). The Portfolio
 * and its mirrored positions remain as an ordinary editable portfolio.
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
  if (!accountLinkId) {
    return NextResponse.json({ error: "accountLinkId required" }, { status: 400 });
  }

  const ok = await disconnectAccount(auth.user.id, accountLinkId);
  if (!ok) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
