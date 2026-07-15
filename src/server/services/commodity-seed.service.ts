import type { CommodityGroup, CurveKind, PrismaClient } from "@prisma/client";

/**
 * Global commodity-curve registry seed. AEGIS OData product codes
 * (providerSymbolRoot) were verified live against /odata/Underlyings +
 * MarketData.ForDate sample pulls on 2026-07-14 — every code returns a
 * non-empty strip. NGL curves arrive from AEGIS in $/GAL but display in
 * ¢/GAL, hence unitScale 100. WCS (NGX WCS) is quoted by AEGIS as a
 * differential to WTI already, so it seeds as BASIS with no transform.
 */
type CurveSeed = {
  code: string;
  name: string;
  group: CommodityGroup;
  kind: CurveKind;
  unit: string;
  decimals: number;
  unitScale: number;
  benchCode: string | null;
  providerSymbolRoot: string;
};

const CURVES: CurveSeed[] = [
  // --- OIL ---
  { code: "WTI", name: "WTI CUSHING", group: "OIL", kind: "FLAT", unit: "$/BBL", decimals: 2, unitScale: 1, benchCode: null, providerSymbolRoot: "CL" },
  { code: "BRN", name: "BRENT", group: "OIL", kind: "FLAT", unit: "$/BBL", decimals: 2, unitScale: 1, benchCode: null, providerSymbolRoot: "I" },
  { code: "MID", name: "WTI MIDLAND", group: "OIL", kind: "BASIS", unit: "$/BBL", decimals: 2, unitScale: 1, benchCode: "WTI", providerSymbolRoot: "M.C9B6" }, // Argus WTI Midland TMA Diff
  { code: "MEH", name: "WTI MEH", group: "OIL", kind: "BASIS", unit: "$/BBL", decimals: 2, unitScale: 1, benchCode: "WTI", providerSymbolRoot: "M.PRUM" }, // Argus WTI Houston TMA Diff
  { code: "CMA", name: "WTI CMA ROLL", group: "OIL", kind: "BASIS", unit: "$/BBL", decimals: 2, unitScale: 1, benchCode: "WTI", providerSymbolRoot: "M.LKDI" }, // Argus WTI CMA Roll
  { code: "WCS", name: "WCS HARDISTY", group: "OIL", kind: "BASIS", unit: "$/BBL", decimals: 2, unitScale: 1, benchCode: "WTI", providerSymbolRoot: "M.ERLK" }, // NGX WCS (quoted as diff)
  // --- GAS ---
  { code: "HH", name: "HENRY HUB", group: "GAS", kind: "FLAT", unit: "$/MMBTU", decimals: 3, unitScale: 1, benchCode: null, providerSymbolRoot: "H" }, // NYMEX Henry Hub (LD)
  { code: "WAHA", name: "WAHA", group: "GAS", kind: "BASIS", unit: "$/MMBTU", decimals: 3, unitScale: 1, benchCode: "HH", providerSymbolRoot: "M.GH9J" },
  { code: "HSC", name: "HOUSTON SHIP CH.", group: "GAS", kind: "BASIS", unit: "$/MMBTU", decimals: 3, unitScale: 1, benchCode: "HH", providerSymbolRoot: "M.HXSB" },
  { code: "SSTAR", name: "SOUTHERN STAR", group: "GAS", kind: "BASIS", unit: "$/MMBTU", decimals: 3, unitScale: 1, benchCode: "HH", providerSymbolRoot: "M.9J3Y" },
  { code: "CGML", name: "COLUMBIA GULF ML", group: "GAS", kind: "BASIS", unit: "$/MMBTU", decimals: 3, unitScale: 1, benchCode: "HH", providerSymbolRoot: "M.MZ0M" }, // CG Mainline Basis
  { code: "AECO", name: "AECO 7A", group: "GAS", kind: "BASIS", unit: "$/MMBTU", decimals: 3, unitScale: 1, benchCode: "HH", providerSymbolRoot: "M.ZVUK" }, // AECO Month Ahead 7a Basis (USD)
  { code: "EPP", name: "EL PASO PERMIAN", group: "GAS", kind: "BASIS", unit: "$/MMBTU", decimals: 3, unitScale: 1, benchCode: "HH", providerSymbolRoot: "M.NQJV" }, // EP Permian Basis
  // --- NGL (AEGIS $/GAL → display ¢/GAL) ---
  { code: "C2NT", name: "ETHANE NON-TET", group: "NGL", kind: "FLAT", unit: "¢/GAL", decimals: 2, unitScale: 100, benchCode: null, providerSymbolRoot: "M.4TDN" }, // OPIS Ethane Mt Belv (non-TET)
  { code: "C4NT", name: "BUTANE NON-TET", group: "NGL", kind: "FLAT", unit: "¢/GAL", decimals: 2, unitScale: 100, benchCode: null, providerSymbolRoot: "M.8WTC" }, // OPIS nButane Mt Belv (non-TET)
  { code: "MBP", name: "MT BELVIEU PROPANE", group: "NGL", kind: "FLAT", unit: "¢/GAL", decimals: 2, unitScale: 100, benchCode: null, providerSymbolRoot: "M.F2V2" }, // OPIS Propane Mt Belv (non-TET)
];

export async function ensureCommodityCurvesSeeded(db: PrismaClient): Promise<void> {
  // Two passes: create/update all curves first, then wire bench relations,
  // so a BASIS curve can reference a bench that appears later in the list.
  for (const [i, c] of CURVES.entries()) {
    await db.commodityCurve.upsert({
      where: { code: c.code },
      create: {
        code: c.code,
        name: c.name,
        group: c.group,
        kind: c.kind,
        unit: c.unit,
        decimals: c.decimals,
        unitScale: c.unitScale,
        providerSymbolRoot: c.providerSymbolRoot,
        sortOrder: i,
      },
      update: {
        name: c.name,
        group: c.group,
        kind: c.kind,
        unit: c.unit,
        decimals: c.decimals,
        unitScale: c.unitScale,
        providerSymbolRoot: c.providerSymbolRoot,
        sortOrder: i,
      },
    });
  }
  const byCode = new Map(
    (await db.commodityCurve.findMany({ select: { id: true, code: true } })).map((r) => [r.code, r.id]),
  );
  for (const c of CURVES) {
    if (!c.benchCode) continue;
    const benchId = byCode.get(c.benchCode);
    if (!benchId) continue;
    await db.commodityCurve.update({
      where: { code: c.code },
      data: { benchCurveId: benchId },
    });
  }
}

/** Curves in the default set seeded for each new user, in display order. */
export const DEFAULT_SET_CODES = ["WTI", "HH", "WAHA", "MID"] as const;

/**
 * Lazily creates the user's default curve set on first read. Idempotent:
 * no-op when the user already owns at least one set.
 */
export async function ensureDefaultCurveSet(db: PrismaClient, userId: string): Promise<void> {
  const existing = await db.curveSet.count({ where: { userId } });
  if (existing > 0) return;
  const curves = await db.commodityCurve.findMany({
    where: { code: { in: [...DEFAULT_SET_CODES] } },
    select: { id: true, code: true },
  });
  const idByCode = new Map(curves.map((c) => [c.code, c.id]));
  await db.curveSet.create({
    data: {
      name: "MY ASSETS",
      userId,
      items: {
        create: DEFAULT_SET_CODES.flatMap((code, i) => {
          const curveId = idByCode.get(code);
          return curveId ? [{ curveId, sortOrder: i, pinned: true }] : [];
        }),
      },
    },
  });
}
