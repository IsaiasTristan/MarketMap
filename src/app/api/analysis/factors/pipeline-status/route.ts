import { NextResponse } from "next/server";
import { getPipelineStatus } from "@/server/services/factor-pipeline.service";

export async function GET() {
  const status = await getPipelineStatus();
  return NextResponse.json(status);
}
