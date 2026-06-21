import { NextResponse } from "next/server";
import { prisma as db } from "@/infrastructure/db/client";
import { resolveUserOrResponse } from "@/lib/api/guards";

export async function GET(req: Request) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const portfolios = await db.portfolio.findMany({
    where: { userId: auth.user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, createdAt: true },
  });
  return NextResponse.json(portfolios);
}

export async function POST(req: Request) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "Untitled Portfolio").slice(0, 100);
  const portfolio = await db.portfolio.create({
    data: { name, userId: auth.user.id },
  });
  return NextResponse.json({ id: portfolio.id, name: portfolio.name });
}
