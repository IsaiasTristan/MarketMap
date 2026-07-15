/**
 * curve-sets.service — per-user named curve sets (the COMMODITIES tab's
 * pinnable working sets). Every function takes the owning userId; routes
 * resolve it via resolveUserOrResponse. First read lazily seeds the default
 * set (commodity-seed.service).
 */
import { prisma } from "@/infrastructure/db/client";
import type { CurveSetDto } from "@/types/commodities";
import { ensureDefaultCurveSet } from "./commodity-seed.service";

function toDto(set: {
  id: string;
  name: string;
  items: { sortOrder: number; pinned: boolean; curve: { code: string } }[];
}): CurveSetDto {
  return {
    id: set.id,
    name: set.name,
    items: set.items
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((i) => ({ curveCode: i.curve.code, sortOrder: i.sortOrder, pinned: i.pinned })),
  };
}

const includeItems = {
  items: { include: { curve: { select: { code: true } } } },
} as const;

export async function listCurveSets(userId: string): Promise<CurveSetDto[]> {
  await ensureDefaultCurveSet(prisma, userId);
  const sets = await prisma.curveSet.findMany({
    where: { userId },
    include: includeItems,
    orderBy: { createdAt: "asc" },
  });
  return sets.map(toDto);
}

export async function createCurveSet(
  userId: string,
  name: string,
  curveCodes: string[] = [],
): Promise<CurveSetDto> {
  const curves = await prisma.commodityCurve.findMany({
    where: { code: { in: curveCodes } },
    select: { id: true, code: true },
  });
  const idByCode = new Map(curves.map((c) => [c.code, c.id]));
  const set = await prisma.curveSet.create({
    data: {
      name,
      userId,
      items: {
        create: curveCodes.flatMap((code, i) => {
          const curveId = idByCode.get(code);
          return curveId ? [{ curveId, sortOrder: i, pinned: true }] : [];
        }),
      },
    },
    include: includeItems,
  });
  return toDto(set);
}

/** Returns null when the set doesn't exist or belongs to someone else. */
export async function renameCurveSet(
  userId: string,
  setId: string,
  name: string,
): Promise<CurveSetDto | null> {
  const owned = await prisma.curveSet.findFirst({ where: { id: setId, userId }, select: { id: true } });
  if (!owned) return null;
  const set = await prisma.curveSet.update({
    where: { id: setId },
    data: { name },
    include: includeItems,
  });
  return toDto(set);
}

export async function deleteCurveSet(userId: string, setId: string): Promise<boolean> {
  const owned = await prisma.curveSet.findFirst({ where: { id: setId, userId }, select: { id: true } });
  if (!owned) return false;
  await prisma.curveSet.delete({ where: { id: setId } });
  return true;
}

/** Replace the set's items wholesale (ordered; sortOrder = array index). */
export async function replaceCurveSetItems(
  userId: string,
  setId: string,
  items: { curveCode: string; pinned: boolean }[],
): Promise<CurveSetDto | null> {
  const owned = await prisma.curveSet.findFirst({ where: { id: setId, userId }, select: { id: true } });
  if (!owned) return null;
  const curves = await prisma.commodityCurve.findMany({
    where: { code: { in: items.map((i) => i.curveCode) } },
    select: { id: true, code: true },
  });
  const idByCode = new Map(curves.map((c) => [c.code, c.id]));

  await prisma.$transaction([
    prisma.curveSetItem.deleteMany({ where: { setId } }),
    prisma.curveSetItem.createMany({
      data: items.flatMap((item, i) => {
        const curveId = idByCode.get(item.curveCode);
        return curveId ? [{ setId, curveId, sortOrder: i, pinned: item.pinned }] : [];
      }),
    }),
  ]);
  const set = await prisma.curveSet.findUnique({ where: { id: setId }, include: includeItems });
  return set ? toDto(set) : null;
}
