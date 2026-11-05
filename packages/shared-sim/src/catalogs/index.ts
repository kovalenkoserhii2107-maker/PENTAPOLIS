/**
 * Unified Master Catalog Loader & Singleton Cache for `@pentapolis/shared-sim`.
 */
import { RAW_SHEETS, SHEET_FILE_MAP } from "./rawSheets.generated.ts";
import { parseUnitsAndTimeSheet, type UnitsAndTimeCatalog } from "./unitsAndTime.ts";
import { parseProductionChainsSheet, type CommodityRecipe } from "./productionChains.ts";
import {
  parseBuildingCatalogSheet,
  parseBuildingLevelsSheet,
  parseBuildingLinksSheet,
  parseCatalogRulesSheet,
  type BuildingCatalogEntry,
  type BuildingLinkEntry,
  type DevelopmentStageSpec,
  type LevelCurveId,
  type LevelCurvePoint,
} from "./buildings.ts";
import { parseVehicleCatalogSheet, type VehicleCatalogEntry } from "./vehicles.ts";
import { parseBuildingVisualsSheet, type BuildingVisualsCatalog } from "./visuals.ts";
import { parsePlayerSectorsSheet, type SectorProfileSpec } from "./sectorsAndLevers.ts";

export interface MasterCatalogs {
  readonly unitsAndTime: UnitsAndTimeCatalog;
  readonly commodities: readonly CommodityRecipe[];
  readonly commoditiesByName: ReadonlyMap<string, CommodityRecipe>;
  readonly stages: readonly DevelopmentStageSpec[];
  readonly levelCurves: ReadonlyMap<LevelCurveId, readonly LevelCurvePoint[]>;
  readonly buildings: readonly BuildingCatalogEntry[];
  readonly buildingsById: ReadonlyMap<string, BuildingCatalogEntry>;
  readonly buildingLinks: ReadonlyMap<string, BuildingLinkEntry>;
  readonly vehicles: readonly VehicleCatalogEntry[];
  readonly vehiclesById: ReadonlyMap<string, VehicleCatalogEntry>;
  readonly visuals: BuildingVisualsCatalog;
  readonly sectors: readonly SectorProfileSpec[];
}

let cachedCatalogs: MasterCatalogs | null = null;

function requireSheet(sheets: Readonly<Record<string, string>>, name: string): string {
  const text = sheets[name];
  if (!text) {
    throw new Error(
      `Missing canonical sheet "${name}". Run \`bun run export-sheets\` to regenerate.`
    );
  }
  return text;
}

export function loadMasterCatalogsFromSheets(
  sheets: Readonly<Record<string, string>> = RAW_SHEETS
): MasterCatalogs {
  const unitsAndTime = parseUnitsAndTimeSheet(requireSheet(sheets, "Units & Time"));
  const commodities = parseProductionChainsSheet(requireSheet(sheets, "Production Chains"));
  const commoditiesByName = new Map(commodities.map((c) => [c.name, c]));

  const stages = parseCatalogRulesSheet(requireSheet(sheets, "Catalog Rules"));
  const levelCurves = parseBuildingLevelsSheet(requireSheet(sheets, "Building Levels"));
  const buildings = parseBuildingCatalogSheet(requireSheet(sheets, "Building Catalog"));
  const buildingsById = new Map(buildings.map((b) => [b.id, b]));
  const buildingLinks = parseBuildingLinksSheet(requireSheet(sheets, "Building Links"));

  const vehicles = parseVehicleCatalogSheet(requireSheet(sheets, "Vehicle Catalog"));
  const vehiclesById = new Map(vehicles.map((v) => [v.id, v]));

  const visuals = parseBuildingVisualsSheet(requireSheet(sheets, "Building Visuals"));
  const sectors = parsePlayerSectorsSheet(requireSheet(sheets, "Player Sectors Balance"));

  return {
    unitsAndTime,
    commodities,
    commoditiesByName,
    stages,
    levelCurves,
    buildings,
    buildingsById,
    buildingLinks,
    vehicles,
    vehiclesById,
    visuals,
    sectors,
  };
}

export function getMasterCatalogs(): MasterCatalogs {
  if (!cachedCatalogs) {
    cachedCatalogs = loadMasterCatalogsFromSheets(RAW_SHEETS);
  }
  return cachedCatalogs;
}

export { RAW_SHEETS, SHEET_FILE_MAP };
export * from "./unitsAndTime.ts";
export * from "./productionChains.ts";
export * from "./buildings.ts";
export * from "./vehicles.ts";
export * from "./visuals.ts";
export * from "./sectorsAndLevers.ts";
