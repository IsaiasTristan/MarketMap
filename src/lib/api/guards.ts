import { NextResponse } from "next/server";
import {
  assertPortfolioAccess,
  assertPositionAccess,
  getCurrentUser,
  requireAdmin,
  type CurrentUser,
} from "@/server/services/auth.service";
import { prisma } from "@/infrastructure/db/client";
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

const MANAGED_PORTFOLIO_MESSAGE =
  "This portfolio is synced from a linked brokerage and is read-only. Disconnect it in the brokerage panel to edit manually.";

/**
 * Route guard: reject manual mutations of a brokerage-managed portfolio.
 *
 * A portfolio paired with a `BrokerageAccountLink` is auto-mirrored from the
 * brokerage on every sync, so allowing manual edits would let the app and the
 * brokerage silently disagree. Returns a 409 `NextResponse` when the portfolio
 * is managed, or `null` to proceed. Apply *after* `requirePortfolioAccess`.
 */
export async function requireUnmanagedPortfolio(
  portfolioId: string,
): Promise<NextResponse | null> {
  const link = await prisma.brokerageAccountLink.findUnique({
    where: { portfolioId },
    select: { id: true },
  });
  if (link) return NextResponse.json({ error: MANAGED_PORTFOLIO_MESSAGE }, { status: 409 });
  return null;
}

/**
 * Same as {@link requireUnmanagedPortfolio} but addressed by a position id
 * (for PATCH/DELETE routes that only have the position). Resolves the position's
 * portfolio first. Returns `null` when the position/portfolio can't be found
 * (the downstream handler surfaces the real not-found error).
 */
export async function requireUnmanagedPositionPortfolio(
  positionId: string,
): Promise<NextResponse | null> {
  const pos = await prisma.portfolioPosition.findUnique({
    where: { id: positionId },
    select: { portfolioId: true },
  });
  if (!pos) return null;
  return requireUnmanagedPortfolio(pos.portfolioId);
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

/**
 * Resolve the current user and require admin, returning either the admin user
 * or a `NextResponse` (401/403) to short-circuit. Used by admin-only routes
 * that also need the user id.
 */
export async function resolveAdminOrResponse(
  req: Request,
): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  try {
    return { user: await requireAdmin(req) };
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return { response: r };
    throw e;
  }
}
