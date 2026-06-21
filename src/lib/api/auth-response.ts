import { NextResponse } from "next/server";
import { ForbiddenError, UnauthorizedError } from "@/server/services/auth.service";

/**
 * Map an auth error thrown by the auth service to an HTTP response. Returns
 * null for any other error so the caller can fall through to its own handling
 * (typically a 500). Usage in a route's catch block:
 *
 *   const r = authErrorResponse(e);
 *   if (r) return r;
 *   // ...existing error handling
 */
export function authErrorResponse(e: unknown): NextResponse | null {
  if (e instanceof UnauthorizedError) {
    return NextResponse.json({ error: e.message }, { status: 401 });
  }
  if (e instanceof ForbiddenError) {
    return NextResponse.json({ error: e.message }, { status: 403 });
  }
  return null;
}
