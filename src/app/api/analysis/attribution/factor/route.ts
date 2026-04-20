/**
 * Legacy route — forwards to the new canonical endpoint.
 * Kept for backwards compatibility during transition.
 */
import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const portfolioId = url.searchParams.get("portfolioId");
  const newUrl = `/api/analysis/factors/attribution${portfolioId ? `?portfolioId=${portfolioId}` : ""}`;
  return NextResponse.redirect(new URL(newUrl, req.url), 308);
}
