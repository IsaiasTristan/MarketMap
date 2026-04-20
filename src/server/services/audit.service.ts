import { prisma as db } from "@/infrastructure/db/client";

export async function writeAuditLog(
  action: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.auditLog.create({
      data: { action, payloadJson: payload ? JSON.parse(JSON.stringify(payload)) : {} },
    });
  } catch {
    // audit failures must never bubble up
  }
}
