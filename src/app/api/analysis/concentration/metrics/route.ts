import { NextResponse } from "next/server";
import { computeConcentration } from "@/server/services/concentration.service";

export const maxDuration = 30;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  if (!portfolioId) return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
  try {
    const result = await computeConcentration(portfolioId);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
