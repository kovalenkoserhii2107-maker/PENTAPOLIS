import { describe, expect, test } from "bun:test";
import {
  STARTER_GATEWAY_IMPORT_TONS_PER_HOUR,
  getMasterCatalogs,
  getZoneMaterialSpecs,
  runDeveloperMarket,
  type BuildingDto,
  type DeveloperSectorInput,
  type ZoneDto,
} from "../src/index.ts";

const catalogs = getMasterCatalogs();

function zone(id: string, zoneKind: ZoneDto["zoneKind"], size = 12, occupancyRatio = 0): ZoneDto {
  return { id, sectorId: 1, zoneKind, x: 0, y: 0, width: size, depth: size, occupancyRatio };
}

function plant(id: string, catalogId: string, level = 1): BuildingDto {
  return {
    id, catalogId, sectorId: 1, tileX: 0, tileY: 0, width: 4, depth: 4, orientationDeg: 0,
    level, constructionProgress: 1, cityEquityShare: 1, stalledAwaitingPrivate: false,
  };
}

const sector = (over: Partial<DeveloperSectorInput> = {}): DeveloperSectorInput => ({
  sectorId: 1, happinessIndex: 70, importDutyRate: 0.06, fxRatePerWcu: 1, gatewayConnected: false, ...over,
});

describe("Developer materials market (GDD §6.1, sheet 20 Table 5)", () => {
  test("reads tons per tile by density from the sheet", () => {
    const specs = getZoneMaterialSpecs();
    expect(specs.get("RES-01")!.tonsPerTile).toMatchObject({ Lumber: 25, "Limestone & Granite": 15, Steel: 0, "Construction Prefabs": 0 });
    expect(specs.get("RES-02")!.tonsPerTile).toMatchObject({ Cement: 45, Steel: 22, Lumber: 18 });
    expect(specs.get("OFF-02")!.tonsPerTile["Construction Prefabs"]).toBe(75);
  });

  test("local sawmill + quarry build cottages without imports or duty; mid-rises stall on cement and steel", () => {
    const out = runDeveloperMarket({
      catalogs,
      zones: [zone("cottages", "RES-01"), zone("condos", "RES-02")],
      buildings: [plant("saw", "PRO-06", 5), plant("quarry", "EXT-04", 5)],
      sectors: [sector()],
      hours: 1,
    });
    const cottages = out.zones.find((z) => z.zoneId === "cottages")!;
    const condos = out.zones.find((z) => z.zoneId === "condos")!;
    expect(cottages.occupancyAfter).toBeGreaterThan(0);
    expect(cottages.dwellingsAdded).toBeGreaterThan(0);
    expect(condos.occupancyAfter).toBe(0);
    expect(["Cement", "Steel"]).toContain(condos.limitingMaterial ?? "none");
    expect(out.importDutyBySector.get(1)).toBe(0n);
    expect(out.sectors[0]!.stalledSites).toBe(1);
  });

  test("gateway imports are capped at the starter tonnage and pay import duty", () => {
    const out = runDeveloperMarket({
      catalogs,
      zones: [zone("towers", "RES-03", 24)],
      buildings: [],
      sectors: [sector({ gatewayConnected: true })],
      hours: 10,
    });
    const s = out.sectors[0]!;
    const imported = s.materials.reduce((t, m) => t + m.importedTonsPerHour, 0);
    expect(imported).toBeCloseTo(STARTER_GATEWAY_IMPORT_TONS_PER_HOUR, 0);
    expect(s.fillRatio).toBeLessThan(1);
    expect(out.importDutyBySector.get(1)!).toBeGreaterThan(0n);
    expect(out.zones[0]!.occupancyAfter).toBeGreaterThan(0);
    // Deterministic
    expect(JSON.stringify(runDeveloperMarket({ catalogs, zones: [zone("towers", "RES-03", 24)], buildings: [], sectors: [sector({ gatewayConnected: true })], hours: 10 }).sectors)).toBe(JSON.stringify(out.sectors));
  });
});
