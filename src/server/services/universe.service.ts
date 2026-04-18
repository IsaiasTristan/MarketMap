import type { PrismaClient } from "@prisma/client";
import type { ParsedUniverseRow } from "@/domain/universe/parse";

export async function createUniverse(
  db: PrismaClient,
  name: string
): Promise<{ id: string }> {
  const u = await db.universe.create({ data: { name } });
  return { id: u.id };
}

export async function replaceUniverseConstituents(
  db: PrismaClient,
  universeId: string,
  rows: ParsedUniverseRow[]
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.universeConstituent.deleteMany({ where: { universeId } });
    let order = 0;
    for (const r of rows) {
      const ticker = r.ticker.toUpperCase();
      const sec = await tx.security.upsert({
        where: { ticker },
        create: { ticker, name: r.companyName },
        update: { name: r.companyName, isActive: true },
      });
      await tx.universeConstituent.create({
        data: {
          universeId,
          securityId: sec.id,
          sector: r.sector,
          subTheme: r.subTheme,
          sortOrder: order++,
        },
      });
    }
  });
}
