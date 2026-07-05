import { NextResponse } from "next/server";
import { getLatestValidation } from "@/server/services/revision/revision-validation.service";

export const maxDuration = 30;

export async function GET() {
  const payload = await getLatestValidation();
  if (!payload) {
    return NextResponse.json(
      { error: "NO_DATA", reason: "No validation stats cached yet. Run the weekly job." },
      { status: 404 },
    );
  }
  return NextResponse.json(payload);
}
