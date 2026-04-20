import { NextResponse } from "next/server";
import { prisma as db } from "@/infrastructure/db/client";

export async function GET() {
  const portfolios = await db.portfolio.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, createdAt: true },
  });
  return NextResponse.json(portfolios);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "Untitled Portfolio").slice(0, 100);
  const portfolio = await db.portfolio.create({ data: { name } });
  return NextResponse.json({ id: portfolio.id, name: portfolio.name });
}
