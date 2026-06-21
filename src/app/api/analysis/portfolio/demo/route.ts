import { NextResponse } from "next/server";
import { prisma as db } from "@/infrastructure/db/client";
import { seedDemoPortfolio } from "@/server/services/position.service";
import { resolveUserOrResponse } from "@/lib/api/guards";

export const maxDuration = 30;

export async function POST(req: Request) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;

  // Find or create a "Demo Portfolio" owned by the current user.
  let portfolio = await db.portfolio.findFirst({
    where: { name: "Demo Portfolio", userId: auth.user.id },
  });
  if (!portfolio) {
    portfolio = await db.portfolio.create({
      data: { name: "Demo Portfolio", userId: auth.user.id },
    });
  }

  const imported = await seedDemoPortfolio(portfolio.id);

  return NextResponse.json({ portfolioId: portfolio.id, imported });
}
