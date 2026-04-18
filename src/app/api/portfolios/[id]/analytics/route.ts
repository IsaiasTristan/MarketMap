import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { computePortfolioAnalytics } from "@/server/services/portfolio.service";
import { z } from "zod";

type Ctx = { params: Promise<{ id: string }> };

const benchEnum = z.enum(["SP500", "NASDAQ", "DOW"]);

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const rawBench = url.searchParams.get("benchmark");
  const benchParsed = rawBench ? benchEnum.safeParse(rawBench) : null;
  const benchmark =
    benchParsed?.success ? benchParsed.data : ("SP500" as const);
  const p = await prisma.portfolio.findUnique({ where: { id } });
  if (!p) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const analytics = await computePortfolioAnalytics(prisma, id, benchmark);
  return NextResponse.json({ ok: true, benchmark, analytics });
}
