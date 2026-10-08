import { NextResponse } from "next/server";
import { resolveAdminOrResponse } from "@/lib/api/guards";
import { snaptradeConfigured } from "@/infrastructure/config/env";
import { createConnectionPortalUrl } from "@/server/services/brokerage/snaptrade-link.service";

/**
 * POST /api/analysis/brokerage/link
 * Returns a SnapTrade Connection Portal URL for the current user to log into
 * their brokerage (Robinhood). Optional body: { reconnect?: string } to
 * re-open a broken connection by brokerageAuthorizationId.
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
  const reconnect = typeof body?.reconnect === "string" ? body.reconnect : undefined;

  // Build the post-connect return URL from forwarded headers (Cloudflare tunnel
  // rewrites host), falling back to the request origin.
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const base = host ? `${proto}://${host}` : new URL(req.url).origin;
  const returnUrl = `${base}/data?linked=1`;

  try {
    const redirectURI = await createConnectionPortalUrl({
      appUserId: auth.user.id,
      returnUrl,
      reconnect,
    });
    return NextResponse.json({ redirectURI });
  } catch (e) {
    console.error("POST /api/analysis/brokerage/link failed:", e);
    return NextResponse.json(
      { error: (e as Error).message ?? "Failed to start brokerage linking" },
      { status: 502 },
    );
  }
}
