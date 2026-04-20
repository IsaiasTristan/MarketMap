import { NextResponse } from "next/server";
import { runFullRefresh } from "@/server/services/data-refresh.service";

export const maxDuration = 120;

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId") ?? undefined;

  try {
    const result = await runFullRefresh(portfolioId);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
