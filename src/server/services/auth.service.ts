/**
 * Identity + authorization for the Cloudflare-Access multi-user model.
 *
 * Trust model:
 *  - Remote users reach the app through a Cloudflare Access application, which
 *    injects a signed `Cf-Access-Jwt-Assertion` header. We verify that JWT
 *    against the team's public keys and read the `email` claim.
 *  - Direct local access (no Access header, e.g. http://localhost:3000 on the
 *    admin's machine) is trusted and treated as the admin.
 *  - Role is derived from the ADMIN_EMAILS allow-list (see env loader) and
 *    mirrored onto the User row. Everyone else is a normal USER.
 *
 * Framework-agnostic: takes a standard `Request` and never imports Next. HTTP
 * status mapping lives in `src/lib/api/auth-response.ts`.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { UserRole } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import {
  adminEmails,
  cfAccessAud,
  cfAccessTeamDomain,
} from "@/infrastructure/config/env";

export interface CurrentUser {
  id: string;
  email: string;
  role: UserRole;
}

/** 401 — could not establish a trusted identity. */
export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** 403 — authenticated but not permitted. */
export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

// jose caches the fetched keys internally; we just memoize the set per domain.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksDomain: string | null = null;
function getJwks(teamDomain: string) {
  if (!jwks || jwksDomain !== teamDomain) {
    jwks = createRemoteJWKSet(
      new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
    );
    jwksDomain = teamDomain;
  }
  return jwks;
}

function roleForEmail(email: string): UserRole {
  return adminEmails().includes(email.toLowerCase()) ? "ADMIN" : "USER";
}

function extractEmail(payload: JWTPayload): string | null {
  const email = (payload as { email?: unknown }).email;
  return typeof email === "string" && email.length > 0 ? email : null;
}

/**
 * Resolve the caller's verified email.
 *  - No Access token  -> trusted local access, returns the admin email.
 *  - Token + team domain configured -> verifies signature/issuer (+ audience
 *    when CF_ACCESS_AUD is set) and returns the JWT email claim.
 *  - Token but team domain NOT configured -> degraded setup mode: warns and
 *    reads the (unverified) `Cf-Access-Authenticated-User-Email` header so the
 *    app keeps working until CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD are set.
 */
async function resolveEmail(req: Request): Promise<string> {
  const token = req.headers.get("cf-access-jwt-assertion");
  const teamDomain = cfAccessTeamDomain();
  const fallbackAdmin = adminEmails()[0] ?? "isaiastristan@live.com";

  if (!token) return fallbackAdmin;

  if (!teamDomain) {
    console.warn(
      "[auth] Cf-Access JWT present but CF_ACCESS_TEAM_DOMAIN is unset — cannot verify; falling back to the unverified email header. Set CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD for the secure path.",
    );
    const hdr = req.headers.get("cf-access-authenticated-user-email");
    return (hdr ?? fallbackAdmin).toLowerCase();
  }

  try {
    const aud = cfAccessAud();
    const { payload } = await jwtVerify(token, getJwks(teamDomain), {
      issuer: `https://${teamDomain}`,
      ...(aud ? { audience: aud } : {}),
    });
    if (!aud) {
      console.warn(
        "[auth] CF_ACCESS_AUD is unset — JWT audience not validated. Set it for full verification.",
      );
    }
    const email = extractEmail(payload);
    if (!email) throw new Error("no email claim in Access JWT");
    return email.toLowerCase();
  } catch (e) {
    throw new UnauthorizedError(
      `Cloudflare Access JWT verification failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

const LOGIN_THROTTLE_MS = 60 * 60 * 1000; // <= 1 lastLoginAt write/hour/user

async function upsertUser(email: string, role: UserRole): Promise<CurrentUser> {
  const existing = await prisma.user.findUnique({ where: { email } });
  const now = new Date();

  if (!existing) {
    const created = await prisma.user.create({
      data: { email, role, lastLoginAt: now },
    });
    return { id: created.id, email: created.email, role: created.role };
  }

  const needsRole = existing.role !== role;
  const needsLogin =
    !existing.lastLoginAt ||
    now.getTime() - existing.lastLoginAt.getTime() > LOGIN_THROTTLE_MS;

  if (needsRole || needsLogin) {
    const updated = await prisma.user.update({
      where: { email },
      data: {
        ...(needsRole ? { role } : {}),
        ...(needsLogin ? { lastLoginAt: now } : {}),
      },
    });
    return { id: updated.id, email: updated.email, role: updated.role };
  }
  return { id: existing.id, email: existing.email, role: existing.role };
}

/**
 * Resolve, provision, and return the current user. Verifies the Access JWT,
 * syncs the role from ADMIN_EMAILS, and throttles the lastLoginAt write.
 * Throws {@link UnauthorizedError} when a remote token fails verification.
 */
export async function getCurrentUser(req: Request): Promise<CurrentUser> {
  const email = await resolveEmail(req);
  return upsertUser(email, roleForEmail(email));
}

/** Returns the current user iff they are an admin; else throws ForbiddenError. */
export async function requireAdmin(req: Request): Promise<CurrentUser> {
  const user = await getCurrentUser(req);
  if (user.role !== "ADMIN") {
    throw new ForbiddenError("Admin access required.");
  }
  return user;
}

/**
 * Assert the user owns the given portfolio. Ownership is required for everyone
 * (the admin's elevated rights cover the global universe / securities, not
 * other users' portfolios). Throws ForbiddenError on miss or not-found.
 */
export async function assertPortfolioAccess(
  user: CurrentUser,
  portfolioId: string,
): Promise<void> {
  const p = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    select: { userId: true },
  });
  if (!p) throw new ForbiddenError("Portfolio not found.");
  if (p.userId !== user.id) {
    throw new ForbiddenError("You do not have access to this portfolio.");
  }
}

/**
 * Assert the user owns the portfolio that contains the given position. Used by
 * position mutation routes that address a position by its own id.
 */
export async function assertPositionAccess(
  user: CurrentUser,
  positionId: string,
): Promise<void> {
  const pos = await prisma.portfolioPosition.findUnique({
    where: { id: positionId },
    select: { portfolio: { select: { userId: true } } },
  });
  if (!pos) throw new ForbiddenError("Position not found.");
  if (pos.portfolio.userId !== user.id) {
    throw new ForbiddenError("You do not have access to this position.");
  }
}
