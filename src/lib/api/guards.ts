import { NextResponse } from "next/server";
import {
  assertPortfolioAccess,
  assertPositionAccess,
  getCurrentUser,
  requireAdmin,
  type CurrentUser,
} from "@/server/services/auth.service";
import { authErrorResponse } from "./auth-response";

/**
 * Route guard: ensure the caller owns `portfolioId`.
 *
 * Returns a `NextResponse` (401/403) to short-circuit the handler, or `null`
 * to proceed. Usage at the top of a route, right after the id is resolved:
 *
 *   const guard = await requirePortfolioAccess(req, portfolioId);
 *   if (guard) return guard;
 */
export async function requirePortfolioAccess(
  req: Request,
  portfolioId: string,
): Promise<NextResponse | null> {
  try {
    const user = await getCurrentUser(req);
    await assertPortfolioAccess(user, portfolioId);
    return null;
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }
}

/**
 * Route guard: ensure the caller owns the portfolio containing `positionId`.
 * Returns a `NextResponse` (401/403) to short-circuit, or `null` to proceed.
 */
export async function requirePositionAccess(
  req: Request,
  positionId: string,
): Promise<NextResponse | null> {
  try {
    const user = await getCurrentUser(req);
    await assertPositionAccess(user, positionId);
    return null;
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }
}

/**
 * Route guard: ensure the caller is an admin. Returns a `NextResponse`
 * (401/403) to short-circuit, or `null` to proceed.
 */
export async function requireAdminGuard(
  req: Request,
): Promise<NextResponse | null> {
  try {
    await requireAdmin(req);
    return null;
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }
}

/**
 * Resolve the current user for a route, returning either the user or a
 * `NextResponse` to short-circuit (only on hard auth failure). Used by routes
 * that need the user id (e.g. to scope a list or stamp ownership on create).
 */
export async function resolveUserOrResponse(
  req: Request,
): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  try {
    return { user: await getCurrentUser(req) };
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return { response: r };
    throw e;
  }
}
