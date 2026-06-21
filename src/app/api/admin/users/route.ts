/**
 * GET /api/admin/users — admin-only roster of authenticated users (email,
 * role, last login). Backs the Users panel in the Data tab.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { requireAdminGuard } from "@/lib/api/guards";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = await requireAdminGuard(req);
  if (guard) return guard;

  const users = await prisma.user.findMany({
    orderBy: [{ lastLoginAt: { sort: "desc", nulls: "last" } }, { email: "asc" }],
    select: { email: true, role: true, lastLoginAt: true, createdAt: true },
  });
  return NextResponse.json({ users });
}
