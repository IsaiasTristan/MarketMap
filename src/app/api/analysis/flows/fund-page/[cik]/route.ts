import { NextResponse, type NextRequest } from "next/server";
import { getFundPage } from "@/server/services/institutional/institutional-fund-page.service";

export const maxDuration = 30;

/** Single-fund signal-provenance page (FUNDS Part 4). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ cik: string }> }) {
  const { cik } = await ctx.params;
  if (!cik || !/\d/.test(cik)) return NextResponse.json({ error: "BAD_CIK", reason: "Invalid CIK." }, { status: 400 });
  const page = await getFundPage(cik);
  if (!page) return NextResponse.json({ error: "NOT_FOUND", reason: "No such fund." }, { status: 404 });
  return NextResponse.json(page);
}
