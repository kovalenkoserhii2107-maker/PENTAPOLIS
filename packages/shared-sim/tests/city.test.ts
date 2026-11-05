import { describe, expect, test } from "bun:test";
import {
  buildAdvisors,
  computeCityServices,
  getCarStages,
  getCityServiceTables,
  getMasterCatalogs,
  planDispatch,
  rollDailyEmergencies,
  runAutoMarket,
  type BuildingDto,
  type CitySectorInput,
  type DistrictDto,
  type NetworkSegmentDto,
  type SectorFleetState,
  type SectorSummaryDto,
  type ZoneDto,
} from "../src/index.ts";

const catalogs = getMasterCatalogs();

function bld(id: string, catalogId: string, tileX: number, tileY: number, level = 1): BuildingDto {
  const e = catalogs.buildingsById.get(catalogId)!;
  return {
    id, catalogId, sectorId: 1, tileX, tileY, width: Math.max(2, e.footprint.width), depth: Math.max(2, e.footprint.depth),
    orientationDeg: 0, level, constructionProgress: 1, cityEquityShare: 1, stalledAwaitingPrivate: false,
  };
}

const zone = (id: string, zoneKind: ZoneDto["zoneKind"], x = 100, y = 100, size = 12, occ = 1): ZoneDto => ({
  id, sectorId: 1, zoneKind, x, y, width: size, depth: size, occupancyRatio: occ,
});

const sector = (decrees: string[] = [], hardshipShare = 0.04): CitySectorInput => ({ sectorId: 1, activeDecreeIds: decrees, hardshipShare });

function district(zones: ZoneDto[], buildings: BuildingDto[], decrees: string[] = []): DistrictDto {
  return computeCityServices({ catalogs, zones, buildings, sectors: [sector(decrees)], emergencies: [] }).districts[0]!;
}

describe("Sheet 25 city tables", () => {
  test("district tiers, service modifiers, land-value floors and car stages come from the sheets", () => {
    const t = getCityServiceTables(catalogs);
    expect(t.tiers.map((x) => x.baseCrimeRate)).toEqual([0.28, 0.145, 0.052, 0.018, 0.004]);
    expect(t.services.get("police")).toMatchObject({ landValueBoost: 0.12, reduction: 0.45, buildingId: "SAF-01" });
    expect(t.services.get("hospital")!.landValueBoost).toBeCloseTo(0.3);
    expect(t.landValueFloor.get("RES-01")).toBe(150);
    expect(t.landValueFloor.get("OFF-02")).toBe(1800);
    const stages = getCarStages();
    expect(stages.map((s) => s.breakdownRiskPerMonth)).toEqual([0.005, 0.032, 0.098, 0.245, 1]);
    expect(stages[0]!.marketPriceUnits).toBe(27830);
  });
});

describe("Districts: services, crime, ecology, land value (GDD §6.3)", () => {
  const homes = zone("homes", "RES-02");

  test("police, fire, clinic and a park raise land value and cut crime", () => {
    const bare = district([homes], []);
    const served = district([homes], [
      bld("pol", "SAF-01", 104, 92),
      bld("fire", "SAF-02", 112, 92),
      bld("clinic", "HLT-01", 96, 92),
      bld("park", "CIV-03", 104, 114),
    ]);
    expect(served.coverage.police).toBe(1);
    expect(served.crimeRate).toBeLessThan(bare.crimeRate * 0.6);
    expect(served.landValuePerTile).toBeGreaterThan(bare.landValuePerTile * 1.5);
    expect(served.tier).toBeGreaterThan(bare.tier);
    expect(served.happiness).toBeGreaterThan(bare.happiness);
  });

  test("smoke from a steel mill drags ecology and land value down; the gas subsidy cleans the air", () => {
    const mill = bld("mill", "PRO-01", 120, 100);
    const clean = district([homes], []);
    const smoky = district([homes], [mill]);
    const subsidised = district([homes], [mill], ["GAS_SUBSIDY"]);
    expect(smoky.ecology).toBeLessThan(clean.ecology - 0.2);
    expect(smoky.landValuePerTile).toBeLessThan(clean.landValuePerTile);
    expect(subsidised.ecology).toBeGreaterThan(smoky.ecology);
  });

  test("an overloaded kindergarten only covers part of the children", () => {
    const tower = zone("tower", "RES-03", 100, 100, 24);
    const d = district([tower], [bld("kg", "EDU-01", 100, 92)]);
    expect(d.coverage.kindergarten).toBeGreaterThan(0);
    expect(d.coverage.kindergarten).toBeLessThan(1);
  });
});

describe("Emergencies & dispatch (GDD §6.6)", () => {
  const road = (id: string, health: number): NetworkSegmentDto => ({
    id, sectorId: 1, kind: "street_2lane", fromX: 100, fromY: 90, toX: 200, toY: 90, hasBridge: false, isFlyover: false, healthPercent: health,
  });
  const homes = zone("homes", "RES-02", 120, 92);
  const base = {
    catalogs, worldId: "w", zones: [homes], active: [],
    sectors: [{ sectorId: 1 as const, activeDecreeIds: [], hardshipShare: 0.04, annualInflation: 0.03, powerDeficit: false }],
  };

  test("broken roads cause crashes; rolls are deterministic per world and day", () => {
    const districts = computeCityServices({ catalogs, zones: [homes], buildings: [], sectors: [sector()], emergencies: [] }).districts;
    let crashes = 0;
    for (let day = 1; day <= 40; day++) {
      const spawns = rollDailyEmergencies({ ...base, gameDay: day, buildings: [], segments: [road("r", 30)], districts });
      crashes += spawns.filter((s) => s.emergencyId === "ROAD_CRASH").length;
      expect(JSON.stringify(rollDailyEmergencies({ ...base, gameDay: day, buildings: [], segments: [road("r", 30)], districts }))).toBe(JSON.stringify(spawns));
    }
    expect(crashes).toBeGreaterThan(3);
    const healthy = rollDailyEmergencies({ ...base, gameDay: 1, buildings: [], segments: [road("r", 90)], districts });
    expect(healthy.some((s) => s.emergencyId === "ROAD_CRASH")).toBe(false);
  });

  test("the Fire Code decree cuts fires, a fire station on the street dispatches an engine", () => {
    const shops = Array.from({ length: 6 }, (_, i) => bld(`b${i}`, "BIZ-02", 110 + i * 10, 92));
    const districts = computeCityServices({ catalogs, zones: [homes], buildings: shops, sectors: [sector()], emergencies: [] }).districts;
    const fires = (decrees: string[]) => {
      let n = 0;
      for (let day = 1; day <= 400; day++) {
        n += rollDailyEmergencies({
          ...base,
          sectors: [{ ...base.sectors[0]!, activeDecreeIds: decrees }],
          gameDay: day, buildings: shops, segments: [road("r", 90)], districts,
        }).filter((s) => s.emergencyId === "FIRE").length;
      }
      return n;
    };
    expect(fires(["FIRE_CODE"])).toBeLessThan(fires([]));

    const station = bld("fs", "SAF-02", 150, 92);
    const plan = planDispatch({ catalogs, emergencyId: "FIRE", sectorId: 1, tileX: 190, tileY: 91, buildings: [station], segments: [road("r", 90)] });
    expect(plan.length).toBe(1);
    expect(plan[0]).toMatchObject({ buildingId: "fs", vehicleTypeId: "MUN-04" });
    expect(plan[0]!.etaHours).toBeGreaterThan(0);
    expect(planDispatch({ catalogs, emergencyId: "FIRE", sectorId: 1, tileX: 190, tileY: 91, buildings: [], segments: [road("r", 90)] })).toEqual([]);
  });
});

describe("Car lifecycle (GDD §6.4, sheet 25 Table 3)", () => {
  test("new households buy cars that age into used, old and scrap; repair shops fix breakdowns", () => {
    const fleet: SectorFleetState = { sectorId: 1, fleet: [0, 0, 0, 0, 0] };
    const households = new Map([[1 as const, 1000]]);
    const common = { catalogs, fleets: [fleet], households, affluentShare: new Map([[1 as const, 0.3]]), avgRoadHealth: new Map([[1 as const, 100]]) };
    const first = runAutoMarket({ ...common, buildings: [], months: 1 })[0]!;
    expect(first.targetFleet).toBe(620);
    // The fleet builds up over a few months rather than overnight
    expect(fleet.fleet.reduce((a, b) => a + b, 0)).toBeCloseTo(620 * 0.35, 0);
    expect(first.newCarsImported).toBe(true);

    let last = first;
    for (let m = 0; m < 24; m++) last = runAutoMarket({ ...common, buildings: [], months: 1 })[0]!;
    expect(fleet.fleet[3]).toBeGreaterThan(0);
    expect(last.scrapTonsPerMonth).toBeGreaterThan(0);
    expect(last.strandedPerMonth).toBe(last.breakdownsPerMonth);

    const withShop = runAutoMarket({ ...common, buildings: [bld("sto", "BIZ-01", 0, 0), bld("dealer", "BIZ-07", 10, 0)], months: 1 })[0]!;
    expect(withShop.repairedPerMonth).toBeGreaterThan(0);
    expect(withShop.newCarsImported).toBe(false);
  });
});

describe("Advisors", () => {
  test("flag missing fire cover, a power deficit and a disconnected gateway", () => {
    const summary = {
      sectorId: 1, currencySymbol: "₴", treasuryBalanceMinor: "900000000", annualInflation: 0.03, keyRate: 0.07,
      creditRating: "AAA", debtToRevenue: 0.2, powerSupplyMw: 35, powerDemandMw: 60, cbBondPurchaseShare: 0,
    } as unknown as SectorSummaryDto;
    const city = computeCityServices({ catalogs, zones: [zone("h", "RES-02")], buildings: [], sectors: [sector()], emergencies: [] }).sectors[0];
    const advisors = buildAdvisors({
      sector: summary, city, transport: undefined, autos: undefined, emergencies: [],
      construction: { sectorId: 1, gatewayImportOpen: false, importCapTonsPerHour: 0, demandTonsPerHour: 0, fillRatio: 1, activeSites: 0, stalledSites: 0, materials: [], importDutyMinor: "0" },
      hasBuilding: () => false,
    });
    expect(advisors.map((a) => a.advisorId)).toEqual(["urban", "finance", "logistics"]);
    expect(advisors[0]!.tips[0]).toMatchObject({ severity: "critical" });
    expect(advisors[0]!.tips[0]!.text).toContain("Пожарная");
    expect(advisors[1]!.tips.some((t) => t.text.includes("Дефицит энергии"))).toBe(true);
    expect(advisors[2]!.tips[0]!.text).toContain("шлюз");
  });
});
