import { describe, expect, test } from "bun:test";
import {
  BASE_WEATHERING_PERCENT_PER_MONTH,
  RegionalMoneyEngine,
  buildCitizenDossier,
  buildNetworkGraph,
  buildVehicleInspector,
  computeTraffic,
  findRoute,
  getMasterCatalogs,
  getRoadClassSpec,
  locateOnGraph,
  roadConditionStage,
  roadHealthSpeedFactor,
  roadRepairCost,
  roadWearPercentPerPass,
  type BuildingDto,
  type BusRouteDto,
  type NetworkSegmentDto,
  type TrafficModelInput,
  type ZoneDto,
} from "../src/index.ts";

const catalogs = getMasterCatalogs();

function seg(id: string, kind: NetworkSegmentDto["kind"], fromX: number, fromY: number, toX: number, toY: number, healthPercent = 100): NetworkSegmentDto {
  return { id, sectorId: 1, kind, fromX, fromY, toX, toY, hasBridge: false, isFlyover: false, healthPercent };
}

function bld(id: string, catalogId: string, tileX: number, tileY: number, extra: Partial<BuildingDto> = {}): BuildingDto {
  const entry = catalogs.buildingsById.get(catalogId)!;
  return {
    id,
    catalogId,
    sectorId: 1,
    tileX,
    tileY,
    width: Math.max(2, entry.footprint.width),
    depth: Math.max(2, entry.footprint.depth),
    orientationDeg: 0,
    level: 1,
    constructionProgress: 1,
    cityEquityShare: 1,
    stalledAwaitingPrivate: false,
    ...extra,
  };
}

function zone(id: string, zoneKind: ZoneDto["zoneKind"], x: number, y: number, size = 12): ZoneDto {
  return { id, sectorId: 1, zoneKind, x, y, width: size, depth: size, occupancyRatio: 1 };
}

function baseInput(over: Partial<TrafficModelInput> = {}): TrafficModelInput {
  return {
    catalogs,
    segments: [seg("main", "street_2lane", 100, 100, 300, 100), seg("spur", "street_2lane", 200, 100, 200, 200)],
    buildings: [],
    zones: [zone("home", "RES-02", 100, 102), zone("shops", "COM-02", 280, 102)],
    busRoutes: [],
    gateways: [],
    sectors: [{ sectorId: 1, activeDecreeIds: [], roadServiceLevel: 1, fxRatePerWcu: 1 }],
    gameHourOfDay: 8,
    version: 1,
    ...over,
  };
}

describe("Road physics (sheet 23 + GDD §5.2)", () => {
  test("reads road classes from sheet 23 and applies pothole / emergency speed stages", () => {
    expect(getRoadClassSpec("street_2lane").speedLimitKmh).toBe(50);
    expect(getRoadClassSpec("heavy_bypass").monthlyDegradationUnderHeavyFreight).toBeCloseTo(0.012);
    expect(roadConditionStage(80)).toBe("good");
    expect(roadConditionStage(60)).toBe("potholes");
    expect(roadConditionStage(39)).toBe("emergency");
    expect(roadHealthSpeedFactor(90)).toBe(1);
    expect(roadHealthSpeedFactor(74)).toBeCloseTo(0.7);
    expect(roadHealthSpeedFactor(40)).toBeCloseTo(0.55);
    expect(roadHealthSpeedFactor(20)).toBeCloseTo(0.3);
  });

  test("a heavy semi wears a street 2,500x a car; a reinforced bypass resists heavy freight", () => {
    const car = roadWearPercentPerPass("street_2lane", 1);
    const semi = roadWearPercentPerPass("street_2lane", catalogs.vehiclesById.get("TRK-02")!.roadWearFactor);
    expect(semi / car).toBeCloseTo(2500);
    expect(roadWearPercentPerPass("heavy_bypass", 2500)).toBeLessThan(semi / 5);
    expect(roadRepairCost("street_2lane", 1000, 50)).toBe(4_500_000n); // 180k/km × 0.5 × 50% → $45,000.00
    expect(roadRepairCost("street_2lane", 1000, 100)).toBe(0n);
  });
});

describe("Network graph & routing (90°/45°)", () => {
  test("splits segments at T-junctions and diagonal crossings", () => {
    const g = buildNetworkGraph(
      [
        seg("a", "street_2lane", 100, 100, 140, 100),
        seg("b", "street_2lane", 120, 100, 120, 130),
        seg("d1", "avenue_4lane", 0, 0, 10, 10),
        seg("d2", "avenue_4lane", 0, 10, 10, 0),
      ],
      "road"
    );
    // T: 4 nodes / 3 edges; X: 5 nodes / 4 edges
    expect(g.nodes.length).toBe(9);
    expect(g.edges.length).toBe(7);
    const from = locateOnGraph(g, 100, 100, 1)!;
    const to = locateOnGraph(g, 120, 130, 1)!;
    const route = findRoute(g, from, to)!;
    expect(route.lengthTiles).toBeCloseTo(50);
    expect(route.points).toEqual([100, 100, 120, 100, 120, 130]);
    const diag = findRoute(g, locateOnGraph(g, 0, 0, 1)!, locateOnGraph(g, 0, 10, 1)!)!;
    expect(diag.lengthTiles).toBeCloseTo(10 * Math.SQRT2);
  });

  test("routes around an emergency-condition road when a healthy detour is faster", () => {
    const g = buildNetworkGraph(
      [
        seg("direct", "street_2lane", 0, 0, 100, 0, 20),
        seg("up", "street_2lane", 0, 0, 0, 10),
        seg("top", "street_2lane", 0, 10, 100, 10),
        seg("down", "street_2lane", 100, 10, 100, 0),
      ],
      "road"
    );
    const route = findRoute(g, locateOnGraph(g, 0, 0, 1)!, locateOnGraph(g, 100, 0, 1)!)!;
    expect(route.lengthTiles).toBeCloseTo(120);
    expect(locateOnGraph(g, 500, 500, 5)).toBeNull();
  });
});

describe("Traffic model: commuters, freight, buses, metro", () => {
  test("commuters drive home -> work, are sampled into visible cars and follow the rush hour", () => {
    const peak = computeTraffic(baseInput({ gameHourOfDay: 8 }));
    const night = computeTraffic(baseInput({ gameHourOfDay: 3 }));
    const s1 = peak.state.sectors[0]!;
    expect(s1.carTripsPerHour).toBeGreaterThan(0);
    expect(s1.carTripsPerHour).toBeGreaterThan(night.state.sectors[0]!.carTripsPerHour * 10);
    const cars = peak.state.vehicles.filter((v) => v.role === "commuter");
    expect(cars.length).toBeGreaterThan(0);
    for (const v of cars) {
      expect(v.path.length).toBeGreaterThanOrEqual(4);
      expect(v.speedTilesPerSec).toBeGreaterThan(0);
      expect(peak.citizens.get(peak.vehicles.get(v.id)!.driverCitizenId)?.vehicleId).toBe(v.id);
    }
    // Deterministic: identical inputs give identical IDs and flows
    expect(JSON.stringify(computeTraffic(baseInput()).state)).toBe(JSON.stringify(peak.state));
  });

  test("ore trucks from a mine to the steel mill wear the street far faster than cars; weight control cuts 25%", () => {
    const segments = [
      seg("haul", "street_2lane", 100, 100, 300, 100),
      seg("quiet", "street_2lane", 100, 300, 300, 300),
    ];
    // A Lv.5 mine (52 t/h) runs ~2 loaded tippers an hour plus empty returns down this street
    const buildings = [bld("mine", "EXT-01", 90, 102, { level: 5 }), bld("mill", "PRO-01", 290, 102)];
    const zones = [zone("home", "RES-02", 100, 302), zone("shops", "COM-02", 280, 302)];
    const out = computeTraffic(baseInput({ segments, buildings, zones }));
    const trucks = out.state.vehicles.filter((v) => v.role === "freight");
    expect(trucks.length).toBeGreaterThan(0);
    expect(trucks.every((t) => t.vehicleTypeId === "TRK-04")).toBe(true);
    const haulWear = out.segmentWearPerHour.get("haul")!;
    const quietWear = out.segmentWearPerHour.get("quiet")!;
    expect(haulWear).toBeGreaterThan(quietWear * 3);

    const controlled = computeTraffic(
      baseInput({
        segments,
        buildings,
        zones,
        sectors: [{ sectorId: 1, activeDecreeIds: ["TRUCK_WEIGHT_CONTROL"], roadServiceLevel: 1, fxRatePerWcu: 1 }],
      })
    );
    const weathering = BASE_WEATHERING_PERCENT_PER_MONTH / 720;
    expect((controlled.segmentWearPerHour.get("haul")! - weathering) / (haulWear - weathering)).toBeCloseTo(0.75);

    const rec = out.vehicles.get(trucks[0]!.id)!;
    expect(rec.cargo?.commodity).toBe("Iron Ore");
    expect(rec.destinationLabel).toContain("mill");
    const card = buildVehicleInspector(rec, catalogs, { fxRatePerWcu: 1, exportDutyRate: 0.01, currencySymbol: "₴" });
    expect(BigInt(card.cargo!.valueMinor)).toBeGreaterThan(0n);
    expect(card.cargo!.dutyPaidMinor).toBe("0");
    expect(card.roadWearPerPassPercent).toBeGreaterThan(0);
  });

  test("a licensed bus route needs a depot, runs buses and takes commuters out of cars", () => {
    const stops = [bld("stopA", "TRN-01", 110, 101), bld("stopB", "TRN-01", 270, 101)];
    const route: BusRouteDto = {
      id: "route-1",
      sectorId: 1,
      name: "№1",
      operatorName: "ТОВ «Тест»",
      stopBuildingIds: ["stopA", "stopB"],
      fleetSize: 4,
      vehicleTypeId: "PT-02",
      licenseFeeMonthlyMinor: "0",
    };
    const noDepot = computeTraffic(baseInput({ buildings: stops, busRoutes: [route] }));
    expect(noDepot.state.busRoutes[0]!.operating).toBe(false);
    expect(noDepot.state.busRoutes[0]!.statusRu).toContain("TRN-02");

    const withDepot = computeTraffic(
      baseInput({ buildings: [...stops, bld("depot", "TRN-02", 150, 110)], busRoutes: [route] })
    );
    expect(withDepot.state.busRoutes[0]!.operating).toBe(true);
    expect(withDepot.state.vehicles.filter((v) => v.role === "bus").length).toBe(4);
    const s = withDepot.state.sectors[0]!;
    expect(s.busCoverageShare).toBeGreaterThan(0);
    expect(s.transitRidersPerHour).toBeGreaterThan(0);
    expect(s.carTripsPerHour).toBeLessThan(noDepot.state.sectors[0]!.carTripsPerHour);
  });

  test("metro trains run underground between stations and halve car trips around them", () => {
    const segments = [...baseInput().segments!, seg("tunnel", "metro_tunnel", 100, 120, 300, 120)];
    const buildings = [
      bld("st1", "TRN-09", 104, 119),
      bld("st2", "TRN-09", 280, 119),
      bld("mdepot", "TRN-10", 150, 140),
    ];
    const before = computeTraffic(baseInput({ segments }));
    const after = computeTraffic(baseInput({ segments, buildings }));
    const trains = after.state.vehicles.filter((v) => v.role === "metro");
    expect(trains.length).toBeGreaterThan(0);
    expect(trains.every((t) => t.layer === "underground" && t.vehicleTypeId === "PT-07")).toBe(true);
    const s = after.state.sectors[0]!;
    expect(s.metroOperational).toBe(true);
    expect(s.metroCoverageShare).toBeGreaterThan(0);
    expect(s.metroLandValueBoostShare).toBeGreaterThan(0);
    expect(s.carTripsPerHour).toBeLessThan(before.state.sectors[0]!.carTripsPerHour * 0.6);
  });
});

describe("Citizen dossier (vehicle -> driver)", () => {
  test("money lines sum exactly to totals and potholes on the commute show up as a complaint", () => {
    const engine = new RegionalMoneyEngine({ mode: "mature" });
    const reg = engine.getRegion(1);
    const regionInput = {
      classes: reg.classes,
      cpi: reg.cpi,
      happinessIndex: reg.happinessIndex,
      annualInflation: 0.03,
      keyRate: reg.levers.keyRate,
      vatRate: reg.levers.vatRate,
      exportDutyRate: reg.levers.exportDutyRate,
      fxRatePerWcu: reg.fxRatePerWcu,
      activeDecreeIds: [],
      powerDeficit: false,
      currencySymbol: "₴",
    };
    const segments = [seg("main", "street_2lane", 100, 100, 300, 100, 35), seg("spur", "street_2lane", 200, 100, 200, 200, 35)];
    const out = computeTraffic(baseInput({ segments }));
    const car = out.state.vehicles.find((v) => v.role === "commuter")!;
    const ctx = out.citizens.get(out.vehicles.get(car.id)!.driverCitizenId)!;
    const dossier = buildCitizenDossier(ctx, regionInput);

    const sum = (lines: readonly { amountMinor: string }[]) => lines.reduce((s, l) => s + BigInt(l.amountMinor), 0n);
    expect(sum(dossier.income)).toBe(BigInt(dossier.totalIncomeMinor));
    expect(sum(dossier.expenses)).toBe(BigInt(dossier.totalExpensesMinor));
    expect(BigInt(dossier.totalIncomeMinor) - BigInt(dossier.totalExpensesMinor)).toBe(BigInt(dossier.netSavingsMinor));
    expect(dossier.thoughts.some((t) => t.text.includes("подвеску"))).toBe(true);
    expect(dossier.vehicleId).toBe(car.id);
    expect(dossier.satisfaction).toBeGreaterThanOrEqual(0);
    expect(dossier.satisfaction).toBeLessThanOrEqual(100);
    expect(JSON.stringify(buildCitizenDossier(ctx, regionInput))).toBe(JSON.stringify(dossier));
  });
});
