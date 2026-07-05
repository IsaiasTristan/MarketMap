import { NextResponse } from "next/server";
import { getSummary } from "@/server/services/revision/revision-query.service";

export const maxDuration = 30;

export async function GET() {
  const summary = await getSummary();
  if (!summary) {
    return NextResponse.json(
      { error: "NO_DATA", reason: "No scores computed yet. Run the weekly job." },
      { status: 404 },
    );
  }
  return NextResponse.json(summary);
}
