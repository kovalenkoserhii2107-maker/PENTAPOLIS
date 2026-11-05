/**
 * Master Building Catalog (127 types), Catalog Rules (Stages S0–S5),
 * Building Levels (Curves Lv.1–5), and Building Links (Supply & Prerequisite Graph).
 *
 * Reads Sheets 02, 03, 04, 05 from the canonical balance workbook (GDD Chapter 7).
 */
import {
  parseBuildMaterials,
  parseCsv,
  parseFootprint,
  parseLandValueEffect,
  parseNum,
  parseRecipeInputs,
  type LandValueModifier,
  type MaterialRequirement,
  type TileFootprint,
} from "../csv.ts";
import { money, mulRate, type Money } from "../money/money.ts";

export type DevelopmentStageId = "S0" | "S1" | "S2" | "S3" | "S4" | "S5";

export type BuildingPrefix =
  | "EXT"
  | "PRO"
  | "CMP"
  | "ASM"
  | "ENG"
  | "INF"
  | "LOG"
  | "TRN"
  | "UTL"
  | "CIV"
  | "EDU"
  | "HLT"
  | "SAF"
  | "RES"
  | "COM"
  | "OFF"
  | "BIZ"
  | "LEI"
  | "TOU"
  | "FIN"
  | "MEG";

export type LevelCurveId =
  | "PROD"
  | "ENERGY"
  | "HUB-TRUCK"
  | "HUB-RAIL"
  | "HUB-SEA"
  | "HUB-AIR"
  | "PUBLIC"
  | "UTILITY"
  | "BUSINESS"
  | "NONE";

export type VisualFamilyId =
  | "RES-LOW"
  | "RES-MID"
  | "RES-HIGH"
  | "PARK"
  | "FUEL"
  | "STOREFRONT"
  | "SUPERMARKET"
  | "BANK"
  | "SINGLE-MODEL";

export type OwnershipContour =
  | "treasury_contour_b" // 100% municipal enterprise (mines, power, pipelines, LNG)
  | "treasury_service"   // 100% municipal infrastructure / civic / transit / hubs
  | "co_invested_10_90"  // 10% city seed / 90% private market (Tier 2–4 plants)
  | "private_developer"  // RCI zoned buildings built by private developers
  | "private_business"   // Autonomous BIZ / LEI / TOU / FIN / scrapyard
  | "megaproject_jv";    // Central Core joint venture shares by contribution

export interface DevelopmentStageSpec {
  readonly stage: DevelopmentStageId;
  readonly name: string;
  readonly minHouseholds: number;
  readonly keyBuildingName: string;
  readonly keyBuildingId: string | null;
  readonly unlocksSummary: string;
  readonly catalogBuildingCount: number;
}

export interface LevelCurvePoint {
  readonly curve: LevelCurveId;
  readonly level: number;
  readonly upgradeCostMultiplier: number; // incremental cost to reach this level (x Lv.1 build cost)
  readonly capacityMultiplier: number;
  readonly workersMultiplier: number;
  readonly engineersMultiplier: number;
  readonly upkeepMultiplier: number;
  readonly powerMultiplier: number;
  readonly upgradeTimeGameHours: number;
}

export interface BuildingCatalogEntry {
  readonly id: string;
  readonly prefix: BuildingPrefix;
  readonly nameEn: string;
  readonly nameRu: string;
  readonly category: string;
  readonly functionDesc: string;
  readonly economicLevel: string;
  readonly ownershipContour: OwnershipContour;
  readonly placement: string;
  readonly unlockStage: DevelopmentStageId;
  readonly unlockCondition: string;
  readonly footprint: TileFootprint;
  readonly buildCostLv1: Money;
  readonly buildCostLv1Units: number;
  readonly buildMaterials: readonly MaterialRequirement[];
  readonly buildMaterialsRaw: string;
  readonly buildTimeGameHours: number;
  readonly upkeepPerMonthLv1: Money;
  readonly upkeepPerMonthLv1Units: number;
  readonly workersLv1: number;
  readonly engineersLv1: number;
  readonly powerMwLv1: number;
  readonly waterM3PerHourLv1: number;
  readonly mainOutput: string;
  readonly capacityLv1: number;
  readonly capacityUnit: string;
  readonly inputsRaw: string;
  readonly recipeInputs: readonly MaterialRequirement[];
  readonly maxLevel: number;
  readonly pollution: number; // 0..3
  readonly landValueEffect: LandValueModifier;
  readonly serviceRadiusTiles: number;
  readonly profileSector: string;
  readonly levelCurve: LevelCurveId;
  readonly visualFamily: VisualFamilyId;
}

export interface BuildingLinkEntry {
  readonly id: string;
  readonly powerConnection: string;
  readonly waterSupply: string;
  readonly wastewater: string;
  readonly railAccess: string;
  readonly pipelineAccess: string;
  readonly siteRequirement: string;
  readonly prerequisiteIds: readonly string[];
  readonly consumes: string;
  readonly produces: string;
  readonly feedsBuildingIds: readonly string[];
  readonly usedAsBuildMaterialByIds: readonly string[];
}

export interface ComputedBuildingLevelStats {
  readonly id: string;
  readonly level: number;
  readonly incrementalUpgradeCost: Money;
  readonly cumulativeCapexFromLv1: Money;
  readonly capacity: number;
  readonly workers: number;
  readonly engineers: number;
  readonly upkeepPerMonth: Money;
  readonly powerMw: number;
  readonly upgradeTimeGameHours: number;
  readonly machineryWearPerDayGas: number;
  readonly machineryWearPerDayCoal: number;
}

/**
 * Fallback constants for the 2 cells in `02_Building Catalog` whose Excel formulas
 * referenced a text header (`CIV-01` -> `Time, Equity & Tech Stack` row 17 instead of 18)
 * or evaluated to `#ERROR!` (`INF-07` -> 2.5x trunk pipeline = 2.5 * $450,000 = $1,125,000).
 */
const CATALOG_FORMULA_FIXUPS: Readonly<
  Record<string, { buildCost?: number; upkeep?: number }>
> = {
  "INF-07": { buildCost: 1_125_000 },
  "CIV-01": { buildCost: 1_200_000, upkeep: 18_000 },
};

const STAGE_KEY_BUILDING_ID: Readonly<Record<string, string | null>> = {
  "Town Hall": "CIV-01",
  "School": "EDU-02",
  "Technical College": "EDU-03",
  "University": "EDU-04",
  "R&D Technopark": "EDU-05",
  "3 of 5 regions at S4": null,
};

function classifyOwnership(prefix: BuildingPrefix, econLevel: string): OwnershipContour {
  const lower = econLevel.toLowerCase();
  if (prefix === "MEG") return "megaproject_jv";
  if (prefix === "PRO" || prefix === "CMP" || prefix === "ASM") return "co_invested_10_90";
  if (prefix === "RES" || prefix === "COM" || prefix === "OFF") return "private_developer";
  if (lower.includes("contour b")) return "treasury_contour_b";
  if (lower.startsWith("treasury")) return "treasury_service";
  return "private_business";
}

function splitIdList(raw: string | undefined): string[] {
  const t = (raw ?? "").trim();
  if (!t || t === "-") return [];
  return t
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Z]{3}-\d{2}$/.test(s));
}

export function parseCatalogRulesSheet(csvText: string): DevelopmentStageSpec[] {
  const rows = parseCsv(csvText);
  const stages: DevelopmentStageSpec[] = [];
  for (let i = 5; i <= 11 && i < rows.length; i++) {
    const r = rows[i]!;
    const stage = (r[1] ?? "").trim() as DevelopmentStageId;
    if (!/^S[0-5]$/.test(stage)) continue;
    const keyBuildingName = (r[4] ?? "").trim();
    stages.push({
      stage,
      name: (r[2] ?? "").trim(),
      minHouseholds: parseNum(r[3]),
      keyBuildingName,
      keyBuildingId: STAGE_KEY_BUILDING_ID[keyBuildingName] ?? null,
      unlocksSummary: (r[5] ?? "").trim(),
      catalogBuildingCount: parseNum(r[6]),
    });
  }
  return stages;
}

export function parseBuildingLevelsSheet(csvText: string): Map<LevelCurveId, LevelCurvePoint[]> {
  const rows = parseCsv(csvText);
  const map = new Map<LevelCurveId, LevelCurvePoint[]>();
  for (let i = 5; i < rows.length; i++) {
    const r = rows[i]!;
    const curve = (r[1] ?? "").trim() as LevelCurveId;
    const lv = parseNum(r[2], -1);
    if (!curve || lv < 1 || curve === ("Building ID" as LevelCurveId)) break;
    const point: LevelCurvePoint = {
      curve,
      level: Math.round(lv),
      upgradeCostMultiplier: parseNum(r[3]),
      capacityMultiplier: parseNum(r[4], 1),
      workersMultiplier: parseNum(r[5], 1),
      engineersMultiplier: parseNum(r[6], 1),
      upkeepMultiplier: parseNum(r[7], 1),
      powerMultiplier: parseNum(r[8], 1),
      upgradeTimeGameHours: parseNum(r[9]),
    };
    const arr = map.get(curve) ?? [];
    arr.push(point);
    map.set(curve, arr);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a.level - b.level);
  }
  return map;
}

export function parseBuildingCatalogSheet(csvText: string): BuildingCatalogEntry[] {
  const rows = parseCsv(csvText);
  const entries: BuildingCatalogEntry[] = [];

  for (let i = 3; i < rows.length; i++) {
    const r = rows[i]!;
    const id = (r[1] ?? "").trim();
    if (!/^[A-Z]{3}-\d{2}$/.test(id)) continue;
    const prefix = id.slice(0, 3) as BuildingPrefix;
    const fixup = CATALOG_FORMULA_FIXUPS[id];
    const buildCostUnits = fixup?.buildCost ?? parseNum(r[11]);
    const upkeepUnits = fixup?.upkeep ?? parseNum(r[14]);
    const econLevel = (r[6] ?? "").trim();
    const buildMaterialsRaw = (r[12] ?? "").trim();
    const inputsRaw = (r[22] ?? "").trim();

    entries.push({
      id,
      prefix,
      nameEn: (r[2] ?? "").trim(),
      nameRu: (r[3] ?? "").trim(),
      category: (r[4] ?? "").trim(),
      functionDesc: (r[5] ?? "").trim(),
      economicLevel: econLevel,
      ownershipContour: classifyOwnership(prefix, econLevel),
      placement: (r[7] ?? "").trim(),
      unlockStage: ((r[8] ?? "S0").trim() || "S0") as DevelopmentStageId,
      unlockCondition: (r[9] ?? "").trim(),
      footprint: parseFootprint(r[10]),
      buildCostLv1: money(buildCostUnits),
      buildCostLv1Units: buildCostUnits,
      buildMaterials: parseBuildMaterials(buildMaterialsRaw),
      buildMaterialsRaw,
      buildTimeGameHours: parseNum(r[13]),
      upkeepPerMonthLv1: money(upkeepUnits),
      upkeepPerMonthLv1Units: upkeepUnits,
      workersLv1: parseNum(r[15]),
      engineersLv1: parseNum(r[16]),
      powerMwLv1: parseNum(r[17]),
      waterM3PerHourLv1: parseNum(r[18]),
      mainOutput: (r[19] ?? "").trim(),
      capacityLv1: parseNum(r[20]),
      capacityUnit: (r[21] ?? "").trim(),
      inputsRaw,
      recipeInputs: parseRecipeInputs(inputsRaw),
      maxLevel: Math.max(1, Math.round(parseNum(r[23], 1))),
      pollution: parseNum(r[24]),
      landValueEffect: parseLandValueEffect(r[25]),
      serviceRadiusTiles: parseNum(r[26]),
      profileSector: (r[27] ?? "").trim(),
      levelCurve: ((r[30] ?? "NONE").trim() || "NONE") as LevelCurveId,
      visualFamily: ((r[31] ?? "SINGLE-MODEL").trim() || "SINGLE-MODEL") as VisualFamilyId,
    });
  }

  return entries;
}

export function parseBuildingLinksSheet(csvText: string): Map<string, BuildingLinkEntry> {
  const rows = parseCsv(csvText);
  const map = new Map<string, BuildingLinkEntry>();
  for (let i = 3; i < rows.length; i++) {
    const r = rows[i]!;
    const id = (r[1] ?? "").trim();
    if (!/^[A-Z]{3}-\d{2}$/.test(id)) continue;
    map.set(id, {
      id,
      powerConnection: (r[3] ?? "").trim(),
      waterSupply: (r[4] ?? "").trim(),
      wastewater: (r[5] ?? "").trim(),
      railAccess: (r[6] ?? "").trim(),
      pipelineAccess: (r[7] ?? "").trim(),
      siteRequirement: (r[8] ?? "").trim(),
      prerequisiteIds: splitIdList(r[9]),
      consumes: (r[10] ?? "").trim(),
      produces: (r[11] ?? "").trim(),
      feedsBuildingIds: splitIdList(r[12]),
      usedAsBuildMaterialByIds: splitIdList(r[14]),
    });
  }
  return map;
}

/**
 * Computes exact stats of any catalog building at `level` (1..maxLevel),
 * matching the `SECTION 2: LEVEL CALCULATOR` formula in `04_Building Levels`.
 */
export function computeBuildingAtLevel(
  entry: BuildingCatalogEntry,
  curves: ReadonlyMap<LevelCurveId, readonly LevelCurvePoint[]>,
  level: number
): ComputedBuildingLevelStats {
  if (level < 1 || level > entry.maxLevel) {
    throw new RangeError(
      `Level ${level} out of bounds for ${entry.id} (1..${entry.maxLevel})`
    );
  }
  const curvePoints = curves.get(entry.levelCurve) ?? curves.get("NONE") ?? [];
  const pt =
    curvePoints.find((p) => p.level === level) ??
    curvePoints[curvePoints.length - 1] ?? {
      curve: entry.levelCurve,
      level: 1,
      upgradeCostMultiplier: 0,
      capacityMultiplier: 1,
      workersMultiplier: 1,
      engineersMultiplier: 1,
      upkeepMultiplier: 1,
      powerMultiplier: 1,
      upgradeTimeGameHours: 0,
    };

  let cumulativeUpgrade = 0n;
  for (const p of curvePoints) {
    if (p.level <= level && p.level > 1) {
      cumulativeUpgrade += mulRate(entry.buildCostLv1, p.upgradeCostMultiplier);
    }
  }
  const incrementalUpgradeCost =
    level === 1 ? 0n : mulRate(entry.buildCostLv1, pt.upgradeCostMultiplier);

  // Machinery wear norm (GDD §4.2 & Sheet 12 City Systems Section 1):
  // Lv.3: 1.4368/day gas, Lv.4: 2.8736/day gas, Lv.5: 4.7414/day gas (+35% on coal)
  const isProdOrExt =
    entry.prefix === "EXT" ||
    entry.prefix === "PRO" ||
    entry.prefix === "CMP" ||
    entry.prefix === "ASM";
  const wearGasByLevel: Record<number, number> = {
    1: 0,
    2: 0,
    3: (5_000_000 * 0.06) / 12 / 580 / 30,
    4: (10_000_000 * 0.06) / 12 / 580 / 30,
    5: (16_500_000 * 0.06) / 12 / 580 / 30,
  };
  const wearGas = isProdOrExt ? (wearGasByLevel[level] ?? 0) : 0;

  return {
    id: entry.id,
    level,
    incrementalUpgradeCost,
    cumulativeCapexFromLv1: entry.buildCostLv1 + cumulativeUpgrade,
    capacity: entry.capacityLv1 * pt.capacityMultiplier,
    workers: entry.workersLv1 * pt.workersMultiplier,
    engineers: entry.engineersLv1 * pt.engineersMultiplier,
    upkeepPerMonth: mulRate(entry.upkeepPerMonthLv1, pt.upkeepMultiplier),
    powerMw: entry.powerMwLv1 * pt.powerMultiplier,
    upgradeTimeGameHours: pt.upgradeTimeGameHours,
    machineryWearPerDayGas: wearGas,
    machineryWearPerDayCoal: wearGas * 1.35,
  };
}

const STAGE_ORDER: readonly DevelopmentStageId[] = ["S0", "S1", "S2", "S3", "S4", "S5"];

export function evaluateRegionStage(
  households: number,
  ownedBuildingIds: ReadonlySet<string>,
  stages: readonly DevelopmentStageSpec[],
  regionsAtS4OrAbove = 0
): DevelopmentStageId {
  let highest: DevelopmentStageId = "S0";
  for (const spec of stages) {
    if (spec.stage === "S0") continue;
    if (households < spec.minHouseholds) break;
    if (spec.stage === "S5") {
      if (regionsAtS4OrAbove >= 3) highest = "S5";
      break;
    }
    if (spec.keyBuildingId && !ownedBuildingIds.has(spec.keyBuildingId)) {
      break;
    }
    highest = spec.stage;
  }
  return highest;
}

export function isStageUnlocked(
  currentRegionStage: DevelopmentStageId,
  requiredStage: DevelopmentStageId
): boolean {
  return STAGE_ORDER.indexOf(currentRegionStage) >= STAGE_ORDER.indexOf(requiredStage);
}
