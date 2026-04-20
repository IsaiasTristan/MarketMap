import { NextResponse } from "next/server";
import { prisma as db } from "@/infrastructure/db/client";
import { seedDemoPortfolio } from "@/server/services/position.service";

export const maxDuration = 30;

export async function POST() {
  // Find or create a "Demo Portfolio"
  let portfolio = await db.portfolio.findFirst({
    where: { name: "Demo Portfolio" },
  });
  if (!portfolio) {
    portfolio = await db.portfolio.create({ data: { name: "Demo Portfolio" } });
  }

  const imported = await seedDemoPortfolio(portfolio.id);

  return NextResponse.json({ portfolioId: portfolio.id, imported });
}
