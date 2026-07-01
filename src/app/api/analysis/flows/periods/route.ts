import { NextResponse } from "next/server";
import { listPeriods } from "@/server/services/institutional/institutional-query.service";

export const maxDuration = 30;

export async function GET() {
  const periods = await listPeriods();
  return NextResponse.json({ periods });
}
