import { describe, expect, test } from "bun:test";
import {
  cargoLaneOf,
  defaultBorderPolicy,
  getCustomsTables,
  getMasterCatalogs,
  laneOpen,
  laneSmugglingRate,
  megaprojectDividends,
  noticeDaysFor,
  runGasNetwork,
  runPowerRing,
  valueListedCompany,
  type BuildingDto,
  type MegaprojectDto,
  type NetworkSegmentDto,
} from "../src/index.ts";

const catalogs = getMasterCatalogs();

function bld(id: string, catalogId: string, tileX: number, tileY: number, sectorId: 1 | 2 = 1, level = 1): BuildingDto {
  const e = catalogs.buildingsById.get(catalogId)!;
  return {
    id, catalogId, sectorId, tileX, tileY, width: Math.max(2, e.footprint.width), depth: Math.max(2, e.footprint.depth),
    orientationDeg: 0, level, constructionProgress: 1, cityEquityShare: 1, stalledAwaitingPrivate: false,
  };
}

const seg = (id: string, kind: NetworkSegmentDto["kind"], sectorId: 1 | 2, fromX: number, fromY: number, toX: number, toY: number): NetworkSegmentDto => ({
  id, sectorId, kind, fromX, fromY, toX, toY, hasBridge: false, isFlyover: false, healthPercent: 100,
});

describe("Customs (sheet 19, GDD §5.3)", () => {
  test("visa regimes, cargo lanes and gas routes come from the sheet", () => {
    const t = getCustomsTables();
    expect(t.visas.get("paid_visa")).toMatchObject({ entryFeeUnits: 45, queueMinutes: 35 });
    expect(t.lanes.get("hydrocarbons")).toMatchObject({ importDuty: 0.08, exportDuty: 0.15, exciseRate: 0.05 });
    expect(t.lanes.get("luxury")!.queueMinutes).toBe(75);
    expect(t.gasRoutes.get("transit1")).toMatchObject({ transitFeePerKm3Units: 18.5, offtakeShare: 0.05 });
    expect(cargoLaneOf("Iron Ore")).toBe("raw");
    expect(cargoLaneOf("Steel")).toBe("manufactured");
    expect(cargoLaneOf("Natural Gas")).toBe("hydrocarbons");
  });

  test("hostile moves wait for the notice window; smuggling rises with prohibitive duty", () => {
    const base = defaultBorderPolicy(1);
    expect(noticeDaysFor(base, { ...base, importDuty: { ...base.importDuty, raw: 0.2 } })).toBe(0);
    expect(noticeDaysFor(base, { ...base, importDuty: { ...base.importDuty, raw: 0.8 } })).toBe(3);
    expect(noticeDaysFor(base, { ...base, embargo: ["raw"] })).toBe(6);
    expect(noticeDaysFor(base, { ...base, visaRegime: "closed" })).toBe(6);

    const high = { ...base, importDuty: { ...base.importDuty, raw: 0.8 } };
    expect(laneSmugglingRate(high, "raw")).toBeGreaterThan(laneSmugglingRate(base, "raw") * 4);
    expect(laneSmugglingRate({ ...high, inspection: "strict" }, "raw")).toBeCloseTo(laneSmugglingRate(high, "raw") / 2);
    expect(laneOpen(base, { ...defaultBorderPolicy(2), embargo: ["raw"] }, "raw")).toBe(false);
    expect(laneOpen(base, defaultBorderPolicy(2), "raw")).toBe(true);
  });
});

describe("Gas network & power ring (GDD §4.2, §4.3)", () => {
  const well = bld("well", "EXT-07", 100, 100);
  const mill = bld("mill", "PRO-01", 140, 96);
  const turbine = bld("gt", "ENG-02", 100, 120);
  const pipe = [seg("p1", "pipeline", 1, 103, 107, 160, 107), seg("p2", "pipeline", 1, 105, 107, 105, 121)];

  test("a pipeline from a gas well boosts the steel mill by sheet's +40% and fuels the turbine", () => {
    const none = runGasNetwork({ catalogs, segments: [], buildings: [well, mill, turbine], links: [], sectorIds: [1] });
    expect(none.outputMultiplier.get("mill")).toBe(1);
    expect(none.turbineSupply.get("gt")).toBe(0);

    const piped = runGasNetwork({ catalogs, segments: pipe, buildings: [well, mill, turbine], links: [], sectorIds: [1] });
    expect(piped.outputMultiplier.get("mill")).toBeCloseTo(1.4);
    expect(piped.pollutionMultiplier.get("mill")).toBeCloseTo(0.45);
    expect(piped.turbineSupply.get("gt")).toBe(1);
    expect(piped.sectors[0]).toMatchObject({ gasifiedPlants: 1, supplyKm3PerHour: 8, demandKm3PerHour: 8 });
  });

  test("gas crosses a border-post link and is shared pro rata when short", () => {
    const mill2 = { ...bld("mill2", "PRO-01", 300, 96, 2), level: 4 };
    const pipe2 = [seg("q1", "pipeline", 2, 250, 107, 330, 107)];
    const link = [{ id: "kpp", ax: 160, ay: 107, bx: 250, by: 107, snapTiles: 1 }];
    const out = runGasNetwork({ catalogs, segments: [...pipe, ...pipe2], buildings: [well, mill, mill2], links: link, sectorIds: [1, 2] });
    // 8k m³ supply vs 2 + 8 demand: 80% each
    expect(out.outputMultiplier.get("mill2")).toBeCloseTo(1 + 0.4 * 0.8);
    expect(out.sectors.find((g) => g.sectorId === 2)!.importedKm3PerHour).toBeGreaterThan(0);
    expect(out.sectors.find((g) => g.sectorId === 1)!.exportedKm3PerHour).toBeGreaterThan(0);
  });

  test("HV lines meeting at a border post let a surplus cover the neighbour's deficit", () => {
    const hv = [seg("h1", "hv_power", 1, 100, 50, 200, 50), seg("h2", "hv_power", 2, 210, 50, 300, 50)];
    const supplyDemand = new Map([[1 as const, { supplyMw: 300, demandMw: 100 }], [2 as const, { supplyMw: 50, demandMw: 130 }]]);
    const isolated = runPowerRing({ segments: hv, links: [], supplyDemand });
    expect(isolated.every((r) => r.importedMw === 0 && r.partners.length === 0)).toBe(true);
    const ring = runPowerRing({ segments: hv, links: [{ id: "kpp", ax: 200, ay: 50, bx: 210, by: 50, snapTiles: 1 }], supplyDemand });
    expect(ring.find((r) => r.sectorId === 2)).toMatchObject({ importedMw: 80, partners: [1] });
    expect(ring.find((r) => r.sectorId === 1)!.exportedMw).toBe(80);
  });
});

describe("Capital markets", () => {
  test("megaproject dividends split exactly by contribution", () => {
    const p: MegaprojectDto = {
      buildingId: "m", catalogId: "MEG-02", nameRu: "", costWcuMinor: "300", fundedWcuMinor: "300", status: "operational",
      constructionProgress: 1, monthlyDividendWcuMinor: "100",
      stakes: [
        { sectorId: 1, contributedWcuMinor: "200", share: 2 / 3 },
        { sectorId: 2, contributedWcuMinor: "100", share: 1 / 3 },
      ],
    };
    const d = megaprojectDividends([p]);
    expect(d.get(1)! + d.get(2)!).toBe(100n);
    expect(d.get(2)).toBe(33n);
  });

  test("a listed plant is valued on book capital times return over the cost of capital", () => {
    const mill = { ...bld("mill", "PRO-01", 0, 0), cityEquityShare: 0.1 };
    const cheap = valueListedCompany({ catalogs, building: mill, fxRatePerWcu: 1, keyRate: 0.03, expectedRoi: 0.15, foreignStakes: [] });
    const dear = valueListedCompany({ catalogs, building: mill, fxRatePerWcu: 1, keyRate: 0.12, expectedRoi: 0.15, foreignStakes: [] });
    expect(BigInt(cheap.marketCapLocalMinor)).toBeGreaterThan(BigInt(dear.marketCapLocalMinor));
    const held = valueListedCompany({ catalogs, building: mill, fxRatePerWcu: 1, keyRate: 0.07, expectedRoi: 0.15, foreignStakes: [{ buildingId: "mill", holderSector: 2, share: 0.3 }] });
    expect(held.privateShare).toBeCloseTo(0.6);
  });
});
