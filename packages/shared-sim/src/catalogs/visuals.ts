/**
 * Deterministic Building Visuals Generator — 140,580 Unique Looks (Sheet 06: `Building Visuals`, GDD §8.1).
 *
 * Every placed building deterministically selects its appearance from `hash(buildingId)` across:
 *   baseModel x roofChoice x facadeChoice x paletteIdx x wearState x propSetIdx x sectorStyle x brand
 * Zero extra network payload: every client computes the identical look from `{ buildingId, catalogId, sectorId, districtClass }`.
 */
import { parseCsv, parseFootprint, parseNum, type TileFootprint } from "../csv.ts";
import type { BuildingCatalogEntry, DevelopmentStageId, VisualFamilyId } from "./buildings.ts";

export type DistrictClassId = "P" | "M" | "R";
export type SectorId = 1 | 2 | 3 | 4 | 5;
export type WearState = "new" | "lived_in" | "worn";

export interface DistrictClassSpec {
  readonly id: DistrictClassId;
  readonly name: string;
  readonly rule: string;
  readonly typicalResidents: string;
  readonly paletteDesc: string;
  readonly materialsDesc: string;
  readonly streetPropsDesc: string;
  readonly wearRangeDesc: string;
}

export interface SectorStyleSpec {
  readonly sectorId: SectorId;
  readonly label: string;
  readonly styleName: string;
  readonly preferredRoofs: readonly string[];
  readonly preferredFacades: readonly string[];
  readonly colors: readonly string[];
  readonly signatureDetails: string;
  readonly primaryHex: string;
  readonly accentHex: string;
  readonly roofHex: string;
}

export interface VisualFamilySpec {
  readonly family: VisualFamilyId;
  readonly catalogIdsRaw: string;
  readonly baseModelCount: number;
  readonly roofChoicesPerModel: number;
  readonly facadeChoicesPerModel: number;
  readonly paletteCount: number;
  readonly wearStateCount: number;
  readonly propSetCount: number;
  readonly sectorStyleCount: number;
  readonly brandCount: number;
  readonly differentLooks: number;
}

export interface BaseModelVariant {
  readonly variantId: string;
  readonly family: VisualFamilyId;
  readonly nameEn: string;
  readonly nameRu: string;
  readonly districtClass: DistrictClassId | "Any";
  readonly floors: number;
  readonly footprint: TileFootprint;
  readonly roofOptions: readonly string[];
  readonly facadeOptions: readonly string[];
  readonly signatureProps: string;
  readonly modelKey: string;
  readonly weight: number;
  readonly unlockStage: DevelopmentStageId;
}

export interface CorporateBrandSpec {
  readonly brandId: string;
  readonly nameEn: string;
  readonly nameRu: string;
  readonly buildingId: string; // BIZ-09, BIZ-10, BIZ-11
  readonly ownerRule: string;
  readonly colorsDesc: string;
  readonly signatureShape: string;
  readonly priceTier: string;
  readonly preferredDistrict: string;
  readonly primaryHex: string;
  readonly secondaryHex: string;
}

export interface BuildingVisualsCatalog {
  readonly districtClasses: readonly DistrictClassSpec[];
  readonly sectorStyles: readonly SectorStyleSpec[];
  readonly families: ReadonlyMap<VisualFamilyId, VisualFamilySpec>;
  readonly totalDifferentLooks: number;
  readonly baseModels: readonly BaseModelVariant[];
  readonly brands: readonly CorporateBrandSpec[];
}

export interface ResolvedBuildingVisual {
  readonly buildingId: string;
  readonly catalogId: string;
  readonly visualFamily: VisualFamilyId;
  readonly variantId: string;
  readonly modelKey: string;
  readonly floors: number;
  readonly roofChoiceIndex: number;
  readonly roofName: string;
  readonly facadeChoiceIndex: number;
  readonly facadeName: string;
  readonly paletteIndex: number;
  readonly wearState: WearState;
  readonly propSetIndex: number;
  readonly sectorId: SectorId;
  readonly districtClass: DistrictClassId;
  readonly brandId: string | null;
  readonly wallHex: string;
  readonly roofHex: string;
  readonly accentHex: string;
}

const SECTOR_HEX_PALETTE: Readonly<
  Record<SectorId, { primaryHex: string; accentHex: string; roofHex: string }>
> = {
  1: { primaryHex: "#9e4738", accentHex: "#d99b43", roofHex: "#3b3f46" },
  2: { primaryHex: "#e9edf2", accentHex: "#1f4e79", roofHex: "#c9b38c" },
  3: { primaryHex: "#c9965b", accentHex: "#5d8a66", roofHex: "#b35c3e" },
  4: { primaryHex: "#dfd3be", accentHex: "#b85d43", roofHex: "#a84c32" },
  5: { primaryHex: "#d8e6f2", accentHex: "#159a9c", roofHex: "#2a4359" },
};

const CLASS_WALL_PALETTES: Readonly<Record<DistrictClassId, readonly string[]>> = {
  P: ["#8f8d88", "#9a8274", "#7d848b", "#a39887", "#87766c", "#747d78", "#9e8e7a", "#6f7378"],
  M: ["#b86f52", "#d8c3a5", "#c98a63", "#cfd6c4", "#bfa588", "#a85d48", "#dfd3be", "#9eb39d"],
  R: ["#f4f6f8", "#d7e7f5", "#eae2d6", "#ffffff", "#cfe0ec", "#f2ece1", "#dce8f2", "#e5dfd5"],
};

const BRAND_HEX: Readonly<Record<string, { primaryHex: string; secondaryHex: string }>> = {
  "BR-FUEL-01": { primaryHex: "#2563eb", secondaryHex: "#ffffff" },
  "BR-FUEL-02": { primaryHex: "#1e3a5f", secondaryHex: "#e0c89f" },
  "BR-FUEL-03": { primaryHex: "#15803d", secondaryHex: "#facc15" },
  "BR-FUEL-04": { primaryHex: "#18181b", secondaryHex: "#f97316" },
  "BR-FUEL-05": { primaryHex: "#0d9488", secondaryHex: "#f8fafc" },
  "BR-FUEL-06": { primaryHex: "#dc2626", secondaryHex: "#ffffff" },
  "BR-FUEL-07": { primaryHex: "#1e3a8a", secondaryHex: "#eab308" },
  "BR-MART-01": { primaryHex: "#2563eb", secondaryHex: "#ffffff" },
  "BR-MART-02": { primaryHex: "#16a34a", secondaryHex: "#fef3c7" },
  "BR-MART-03": { primaryHex: "#eab308", secondaryHex: "#dc2626" },
  "BR-MART-04": { primaryHex: "#171717", secondaryHex: "#d4af37" },
  "BR-BANK-01": { primaryHex: "#2563eb", secondaryHex: "#94a3b8" },
  "BR-BANK-02": { primaryHex: "#475569", secondaryHex: "#b91c1c" },
  "BR-BANK-03": { primaryHex: "#f8fafc", secondaryHex: "#0d9488" },
  "BR-BANK-04": { primaryHex: "#1d4ed8", secondaryHex: "#ffffff" },
};

/** FNV-1a 32-bit deterministic hash + SplitMix-like mixer. */
export function hashString32(input: string, salt = 0): number {
  let h = (0x811c9dc5 ^ salt) >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function parseBuildingVisualsSheet(csvText: string): BuildingVisualsCatalog {
  const rows = parseCsv(csvText);

  const districtClasses: DistrictClassSpec[] = [];
  for (let i = 5; i <= 7 && i < rows.length; i++) {
    const r = rows[i]!;
    const id = (r[1] ?? "").trim() as DistrictClassId;
    if (id === "P" || id === "M" || id === "R") {
      districtClasses.push({
        id,
        name: (r[2] ?? "").trim(),
        rule: (r[3] ?? "").trim(),
        typicalResidents: (r[4] ?? "").trim(),
        paletteDesc: (r[5] ?? "").trim(),
        materialsDesc: (r[6] ?? "").trim(),
        streetPropsDesc: (r[7] ?? "").trim(),
        wearRangeDesc: (r[8] ?? "").trim(),
      });
    }
  }

  const sectorStyles: SectorStyleSpec[] = [];
  for (let i = 12; i <= 16 && i < rows.length; i++) {
    const r = rows[i]!;
    const label = (r[1] ?? "").trim();
    const m = /^S([1-5])\b/.exec(label);
    if (!m) continue;
    const sectorId = parseInt(m[1]!, 10) as SectorId;
    const hex = SECTOR_HEX_PALETTE[sectorId];
    sectorStyles.push({
      sectorId,
      label,
      styleName: (r[2] ?? "").trim(),
      preferredRoofs: (r[3] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      preferredFacades: (r[4] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      colors: (r[5] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      signatureDetails: (r[6] ?? "").trim(),
      ...hex,
    });
  }

  const families = new Map<VisualFamilyId, VisualFamilySpec>();
  let totalDifferentLooks = 0;
  for (let i = 29; i <= 38 && i < rows.length; i++) {
    const r = rows[i]!;
    const fam = (r[1] ?? "").trim();
    if (!fam || fam.startsWith("Total")) {
      if (fam.startsWith("Total")) totalDifferentLooks = Math.round(parseNum(r[11]));
      continue;
    }
    const family = fam as VisualFamilyId;
    const differentLooks = Math.round(parseNum(r[11]));
    families.set(family, {
      family,
      catalogIdsRaw: (r[2] ?? "").trim(),
      baseModelCount: Math.round(parseNum(r[3], 1)),
      roofChoicesPerModel: Math.round(parseNum(r[4], 1)),
      facadeChoicesPerModel: Math.round(parseNum(r[5], 1)),
      paletteCount: Math.round(parseNum(r[6], 1)),
      wearStateCount: Math.round(parseNum(r[7], 3)),
      propSetCount: Math.round(parseNum(r[8], 1)),
      sectorStyleCount: Math.round(parseNum(r[9], 5)),
      brandCount: Math.round(parseNum(r[10], 1)),
      differentLooks,
    });
  }
  if (totalDifferentLooks === 0) {
    for (const f of families.values()) totalDifferentLooks += f.differentLooks;
  }

  const baseModels: BaseModelVariant[] = [];
  for (let i = 44; i <= 112 && i < rows.length; i++) {
    const r = rows[i]!;
    const variantId = (r[1] ?? "").trim();
    const family = (r[2] ?? "").trim() as VisualFamilyId;
    if (!variantId || !family) continue;
    const dcRaw = (r[5] ?? "Any").trim();
    const districtClass: DistrictClassId | "Any" =
      dcRaw === "P" || dcRaw === "M" || dcRaw === "R" ? dcRaw : "Any";
    baseModels.push({
      variantId,
      family,
      nameEn: (r[3] ?? "").trim(),
      nameRu: (r[4] ?? "").trim(),
      districtClass,
      floors: Math.max(0, Math.round(parseNum(r[6], 1))),
      footprint: parseFootprint(r[7]),
      roofOptions: (r[8] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s !== "-"),
      facadeOptions: (r[9] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s !== "-"),
      signatureProps: (r[10] ?? "").trim(),
      modelKey: (r[11] ?? `${variantId.toLowerCase()}.glb`).trim(),
      weight: parseNum(r[12], 10),
      unlockStage: ((r[13] ?? "S0").trim() || "S0") as DevelopmentStageId,
    });
  }

  // Synthesize the 3 SUPERMARKET and 3 BANK base models referenced in Section 4 rows 36–37
  const syntheticModels: BaseModelVariant[] = [
    {
      variantId: "SUPERMARKET-01",
      family: "SUPERMARKET",
      nameEn: "Neighborhood Supermarket Hall",
      nameRu: "Районный супермаркет",
      districtClass: "P",
      floors: 1,
      footprint: parseFootprint("8x6"),
      roofOptions: ["Flat", "Shed"],
      facadeOptions: ["Metal cladding", "Panel concrete"],
      signatureProps: "Trolley bay, delivery dock",
      modelKey: "supermarket_01.glb",
      weight: 10,
      unlockStage: "S2",
    },
    {
      variantId: "SUPERMARKET-02",
      family: "SUPERMARKET",
      nameEn: "Modern Glass Supermarket",
      nameRu: "Современный супермаркет",
      districtClass: "M",
      floors: 2,
      footprint: parseFootprint("8x6"),
      roofOptions: ["Flat", "Gable"],
      facadeOptions: ["Glass curtain", "Render"],
      signatureProps: "Parking lot, trees",
      modelKey: "supermarket_02.glb",
      weight: 10,
      unlockStage: "S2",
    },
    {
      variantId: "SUPERMARKET-03",
      family: "SUPERMARKET",
      nameEn: "Gourmet Food Emporium",
      nameRu: "Гастрономический павильон",
      districtClass: "R",
      floors: 2,
      footprint: parseFootprint("8x6"),
      roofOptions: ["Mansard", "Green roof"],
      facadeOptions: ["Stone", "Glass curtain"],
      signatureProps: "Stone arcade, valet bay",
      modelKey: "supermarket_03.glb",
      weight: 10,
      unlockStage: "S2",
    },
    {
      variantId: "BANK-01",
      family: "BANK",
      nameEn: "Credit Union Office",
      nameRu: "Отделение кредитного союза",
      districtClass: "P",
      floors: 2,
      footprint: parseFootprint("3x3"),
      roofOptions: ["Flat"],
      facadeOptions: ["Plain brick", "Render"],
      signatureProps: "ATM wall, armored van bay",
      modelKey: "bank_01.glb",
      weight: 10,
      unlockStage: "S1",
    },
    {
      variantId: "BANK-02",
      family: "BANK",
      nameEn: "Classical Portico Bank",
      nameRu: "Классический банк с портиком",
      districtClass: "M",
      floors: 3,
      footprint: parseFootprint("3x3"),
      roofOptions: ["Hip"],
      facadeOptions: ["Stone", "Red brick"],
      signatureProps: "Columns, clock",
      modelKey: "bank_02.glb",
      weight: 10,
      unlockStage: "S1",
    },
    {
      variantId: "BANK-03",
      family: "BANK",
      nameEn: "Private Banking Glass Cube",
      nameRu: "Стеклянный куб частного банка",
      districtClass: "R",
      floors: 4,
      footprint: parseFootprint("3x3"),
      roofOptions: ["Flat"],
      facadeOptions: ["Glass curtain", "Stone"],
      signatureProps: "Fountain, security bollards",
      modelKey: "bank_03.glb",
      weight: 10,
      unlockStage: "S1",
    },
  ];
  baseModels.push(...syntheticModels);

  const brands: CorporateBrandSpec[] = [];
  for (let i = 115; i < rows.length; i++) {
    const r = rows[i]!;
    const brandId = (r[1] ?? "").trim();
    if (!brandId.startsWith("BR-")) continue;
    const hex = BRAND_HEX[brandId] ?? { primaryHex: "#2563eb", secondaryHex: "#ffffff" };
    brands.push({
      brandId,
      nameEn: (r[2] ?? "").trim(),
      nameRu: (r[3] ?? "").trim(),
      buildingId: (r[4] ?? "").trim(),
      ownerRule: (r[5] ?? "").trim(),
      colorsDesc: (r[6] ?? "").trim(),
      signatureShape: (r[7] ?? "").trim(),
      priceTier: (r[8] ?? "").trim(),
      preferredDistrict: (r[9] ?? "").trim(),
      ...hex,
    });
  }

  return {
    districtClasses,
    sectorStyles,
    families,
    totalDifferentLooks,
    baseModels,
    brands,
  };
}

const WEAR_STATES: readonly WearState[] = ["new", "lived_in", "worn"];

/**
 * Deterministically picks the complete 3D visual descriptor for a placed building instance.
 */
export function pickBuildingVisual(
  buildingId: string,
  catalogEntry: BuildingCatalogEntry,
  visuals: BuildingVisualsCatalog,
  sectorId: SectorId,
  districtClass: DistrictClassId = "M",
  explicitBrandId?: string
): ResolvedBuildingVisual {
  const family = catalogEntry.visualFamily;
  const famSpec = visuals.families.get(family);
  const candidates = visuals.baseModels.filter(
    (m) =>
      m.family === family &&
      (m.districtClass === districtClass || m.districtClass === "Any")
  );
  const allFamilyModels =
    candidates.length > 0
      ? candidates
      : visuals.baseModels.filter((m) => m.family === family);

  const h0 = hashString32(buildingId, 1);
  const h1 = hashString32(buildingId, 2);
  const h2 = hashString32(buildingId, 3);
  const h3 = hashString32(buildingId, 4);

  let variantId = `${catalogEntry.id}-01`;
  let modelKey = `${catalogEntry.id.toLowerCase()}.glb`;
  let floors = Math.max(1, Math.min(25, Math.round(Math.sqrt(catalogEntry.footprint.width * catalogEntry.footprint.depth))));
  let roofOptions: readonly string[] = ["Flat"];
  let facadeOptions: readonly string[] = ["Concrete"];

  if (allFamilyModels.length > 0) {
    const chosen = allFamilyModels[h0 % allFamilyModels.length]!;
    variantId = chosen.variantId;
    modelKey = chosen.modelKey;
    floors = chosen.floors;
    if (chosen.roofOptions.length > 0) roofOptions = chosen.roofOptions;
    if (chosen.facadeOptions.length > 0) facadeOptions = chosen.facadeOptions;
  }

  const roofCount = Math.max(1, famSpec?.roofChoicesPerModel ?? roofOptions.length);
  const facadeCount = Math.max(1, famSpec?.facadeChoicesPerModel ?? facadeOptions.length);
  const paletteCount = Math.max(1, famSpec?.paletteCount ?? 8);
  const propCount = Math.max(1, famSpec?.propSetCount ?? 1);

  const roofChoiceIndex = h1 % roofCount;
  const facadeChoiceIndex = (h1 >>> 8) % facadeCount;
  const paletteIndex = h2 % paletteCount;
  const propSetIndex = (h2 >>> 8) % propCount;

  const wearAllowed: readonly WearState[] =
    districtClass === "R"
      ? ["new"]
      : districtClass === "M"
        ? ["new", "lived_in"]
        : WEAR_STATES;
  const wearState = wearAllowed[h3 % wearAllowed.length]!;

  let brandId: string | null = explicitBrandId ?? null;
  if (!brandId && (famSpec?.brandCount ?? 1) > 1) {
    const matchingBrands = visuals.brands.filter(
      (b) => b.buildingId === catalogEntry.id || (family === "BANK" && b.brandId.startsWith("BR-BANK"))
    );
    if (matchingBrands.length > 0) {
      brandId = matchingBrands[(h3 >>> 8) % matchingBrands.length]!.brandId;
    }
  }

  const sectorHex = SECTOR_HEX_PALETTE[sectorId];
  const classWalls = CLASS_WALL_PALETTES[districtClass];
  const brandSpec = brandId ? visuals.brands.find((b) => b.brandId === brandId) : undefined;

  const wallHex =
    family === "SINGLE-MODEL"
      ? sectorHex.primaryHex
      : brandSpec?.primaryHex ?? classWalls[paletteIndex % classWalls.length]!;
  const accentHex = brandSpec?.secondaryHex ?? sectorHex.accentHex;
  const roofHex = sectorHex.roofHex;

  return {
    buildingId,
    catalogId: catalogEntry.id,
    visualFamily: family,
    variantId,
    modelKey,
    floors,
    roofChoiceIndex,
    roofName: roofOptions[roofChoiceIndex % roofOptions.length] ?? "Flat",
    facadeChoiceIndex,
    facadeName: facadeOptions[facadeChoiceIndex % facadeOptions.length] ?? "Standard",
    paletteIndex,
    wearState,
    propSetIndex,
    sectorId,
    districtClass,
    brandId,
    wallHex,
    roofHex,
    accentHex,
  };
}
