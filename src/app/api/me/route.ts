/**
 * GET /api/me — the current user's identity + role. Drives client-side gating
 * (hiding admin controls). Returns 401 only when a remote Access token fails
 * verification; local/no-token access resolves to the admin.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/services/auth.service";
import { authErrorResponse } from "@/lib/api/auth-response";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    return NextResponse.json({ email: user.email, role: user.role });
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    console.error("[/api/me] failed:", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
