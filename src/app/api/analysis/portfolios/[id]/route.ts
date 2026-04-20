import { NextResponse } from "next/server";
import { prisma as db } from "@/infrastructure/db/client";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim().slice(0, 100);
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const portfolio = await db.portfolio.update({
    where: { id },
    data: { name },
    select: { id: true, name: true },
  });
  return NextResponse.json(portfolio);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await db.portfolio.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}