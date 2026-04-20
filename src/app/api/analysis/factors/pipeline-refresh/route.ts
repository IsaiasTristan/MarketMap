import { NextResponse } from "next/server";
import { refreshFactorPipeline } from "@/server/services/factor-pipeline.service";

export const maxDuration = 300;

export async function POST() {
  try {
    const result = await refreshFactorPipeline();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
