import { NextResponse } from "next/server";
import { runCustomShock } from "@/server/services/stress.service";

export const maxDuration = 30;

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId) return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  try {
    const result = await runCustomShock(portfolioId, body);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
