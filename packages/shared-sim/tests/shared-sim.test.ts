import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CANONICAL_DECREES,
  CANONICAL_EMERGENCIES,
  CORE_RADIUS_TILES,
  GRID_HEIGHT,
  GRID_WIDTH,
  NATIONAL_CURRENCIES,
  OwnerCode,
  RAW_SHEETS,
  RegionalMoneyEngine,
  SHEET_FILE_MAP,
  SurfaceType,
  computeBuildingAtLevel,
  computeDualCalendar,
  computeHegemonyScores,
  computeProductQuality,
  evaluateRegionStage,
  generatePeninsulaMap,
  getMasterCatalogs,
  money,
  pickBuildingVisual,
  snapToHybridGrid45,
  toUnits,
  validateAndQuoteNetworkSegment,
  validateSeasonCurrencies,
} from "../src/index.ts";

const SHEETS_DIR = resolve(import.meta.dir, "..", "data", "sheets");

describe("Canonical CSV Sheets & Master Catalogs (Sprint 1)", () => {
  test("all 25 exported CSV files match embedded RAW_SHEETS byte-for-byte", () => {
    const entries = Object.entries(SHEET_FILE_MAP);
    expect(entries.length).toBe(25);
    for (const [sheetName, fileName] of entries) {
      const diskCsv = readFileSync(join(SHEETS_DIR, fileName), "utf8");
      expect(RAW_SHEETS[sheetName]).toBe(diskCsv);
    }
  });

  test("loads Dual Calendars, 24 Production Chains, 127 Buildings, and 56 Vehicles", () => {
    const cat = getMasterCatalogs();

    // Dual Calendars & Time Base (GDD §1.4)
    expect(cat.unitsAndTime.timeBase.realSecondsPerGameHour).toBe(120);
    expect(cat.unitsAndTime.timeBase.gameHoursPerGameMonth).toBe(720);
    expect(cat.unitsAndTime.timeBase.gameSecondsPerMicroTick).toBe(30);
    expect(cat.unitsAndTime.timeBase.citizenLifeYearsPerGameMonth).toBe(1);

    const calAfterOneMonth = computeDualCalendar(720 * 3600, cat.unitsAndTime.timeBase);
    expect(calAfterOneMonth.economicMonth).toBe(2);
    expect(calAfterOneMonth.economicDayOfMonth).toBe(1);
    expect(calAfterOneMonth.citizenLifeYearsElapsed).toBeCloseTo(1.0, 6);

    // 24 commodities across Tiers 1–4, every Tier 2–4 good has positive value-added margin
    expect(cat.commodities.length).toBe(24);
    for (const c of cat.commodities) {
      expect(c.worldReferencePrice > 0n).toBe(true);
      if (c.tier >= 2) {
        expect(c.inputs.length).toBeGreaterThan(0);
        expect(c.valueAddedMargin).toBeGreaterThan(0.19);
      }
    }
    const steel = cat.commoditiesByName.get("Steel")!;
    expect(steel.gasOutputBoostMultiplier).toBeCloseTo(1.4, 4);
    expect(steel.gasEnergyCostMultiplier).toBeCloseTo(0.75, 4);

    // 127 Building types across S0–S5 with zero missing build costs
    expect(cat.buildings.length).toBe(127);
    expect(cat.buildingLinks.size).toBe(127);
    for (const b of cat.buildings) {
      expect(b.buildCostLv1 > 0n).toBe(true);
    }

    // Verify exact Level Calculator reference from Sheet 04 (`PRO-01` at Lv.3)
    const pro01 = cat.buildingsById.get("PRO-01")!;
    const lv3 = computeBuildingAtLevel(pro01, cat.levelCurves, 3);
    expect(lv3.capacity).toBeCloseTo(12, 5);
    expect(lv3.workers).toBeCloseTo(135, 5);
    expect(lv3.engineers).toBeCloseTo(37.5, 5);
    expect(toUnits(lv3.upkeepPerMonth)).toBeCloseTo(112_500, 2);
    expect(lv3.powerMw).toBeCloseTo(60, 5);
    expect(toUnits(lv3.cumulativeCapexFromLv1)).toBeCloseTo(12_526_315.79, 0);

    // Stage progression S0 -> S5
    expect(cat.stages.length).toBe(6);
    const owned = new Set(["CIV-01", "EDU-02", "EDU-03"]);
    expect(evaluateRegionStage(6_000, owned, cat.stages)).toBe("S2");

    // 56 Vehicle types, zero marshrutkas (GDD §5.4, §7)
    expect(cat.vehicles.length).toBe(56);
    for (const v of cat.vehicles) {
      expect(v.nameRu.toLowerCase()).not.toContain("маршрутк");
      expect(v.nameEn.toLowerCase()).not.toContain("marshrutka");
    }

    // 5 Sectors, 8 Decrees, 12 Emergencies, Quality 1★–5★
    expect(cat.sectors.length).toBe(5);
    expect(CANONICAL_DECREES.length).toBe(8);
    expect(CANONICAL_EMERGENCIES.length).toBe(12);
    const q5 = computeProductQuality({
      facilityLevel: 5,
      engineerShare: 0.2,
      technoparkCount: 2,
    });
    expect(q5.stars).toBe(5);
    expect(q5.priceMultiplier).toBe(1.5);
  });

  test("deterministic Building Visuals catalog yields 140,580 unique looks", () => {
    const cat = getMasterCatalogs();
    expect(cat.visuals.totalDifferentLooks).toBe(140_580);
    expect(cat.visuals.brands.length).toBe(15);

    const resLow = cat.buildingsById.get("RES-01")!;
    const lookA1 = pickBuildingVisual("lot-101-202", resLow, cat.visuals, 1, "M");
    const lookA2 = pickBuildingVisual("lot-101-202", resLow, cat.visuals, 1, "M");
    const lookB = pickBuildingVisual("lot-101-203", resLow, cat.visuals, 1, "M");
    expect(lookA1).toEqual(lookA2); // 100% deterministic across clients
    expect(
      lookA1.variantId !== lookB.variantId ||
        lookA1.paletteIndex !== lookB.paletteIndex ||
        lookA1.propSetIndex !== lookB.propSetIndex
    ).toBe(true);
  });

  test("sovereign currencies enforce mandatory Hryvnia (₴ UAH) and exclude ruble", () => {
    expect(NATIONAL_CURRENCIES.length).toBe(16);
    expect(NATIONAL_CURRENCIES[0]!.code).toBe("UAH");
    expect(NATIONAL_CURRENCIES[0]!.symbol).toBe("₴");
    for (const c of NATIONAL_CURRENCIES) {
      expect(c.nameRu.toLowerCase()).not.toContain("рубл");
      expect(c.nameEn.toLowerCase()).not.toContain("ruble");
    }
    expect(validateSeasonCurrencies(["PLN", "KR", "TLR", "FLR", "DUC"]).valid).toBe(false);
    expect(validateSeasonCurrencies(["UAH", "PLN", "KR", "FLR", "DUC"]).valid).toBe(true);
    expect(validateSeasonCurrencies(["UAH", "UAH", "KR", "FLR", "DUC"]).valid).toBe(false);
  });
});

describe("Five-Region BigInt Double-Entry Money Engine (36-Month Invariants)", () => {
  test("closes all 180 matrices over 36 months with exact 0n error across all 4 invariants", () => {
    const engine = new RegionalMoneyEngine({
      currencies: ["UAH", "PLN", "KR", "FLR", "DUC"],
      policies: {
        1: "taylor",
        2: "taylor",
        3: "taylor",
        4: "populist", // 3% rate + 80% CB bond monetisation -> triggers inflation & IMF
        5: "hawk",     // 12% rate + 8% reserve ratio
      },
      mode: "mature",
    });

    // Enable SWF sterilization in oil/gas Sector 2 and a cross-border concession S1 -> S4
    engine.getRegion(2).levers.swfSterilizationShare = 0.30;
    engine.addResourceConcession({
      contractId: "conc-s4-stone-by-s1",
      landownerSector: 4,
      operatorSector: 1,
      resourceName: "Limestone & Granite",
      monthlyExtractedValueWcu: 2_000_000,
      royaltyRate: 0.15,
      monthsRemaining: 12,
    });

    // Test 10% / 90% factory co-investment + municipal buyout + dilutive upgrade
    const p1 = engine.createFactoryProject({
      projectId: "s1-mill",
      sectorId: 1,
      buildingCatalogId: "PRO-01",
      buildCostLocal: money(2_000_000),
      expectedAnnualRoi: 0.16,
    });
    expect(p1.status).toBe("operational");
    expect(p1.cityShare).toBeCloseTo(0.10, 6);
    expect(p1.privateShare).toBeCloseTo(0.90, 6);

    const p5Stalled = engine.createFactoryProject({
      projectId: "s5-chip",
      sectorId: 5,
      buildingCatalogId: "CMP-02",
      buildCostLocal: money(3_500_000),
      expectedAnnualRoi: 0.10, // below Hawk R5 loan rate (~15.7%)
    });
    expect(p5Stalled.status).toBe("awaiting_private_investors");
    engine.mayorBuyoutStalledFactory(5, "s5-chip", money(3_500_000));
    expect(p5Stalled.status).toBe("operational");
    expect(p5Stalled.cityShare).toBe(1.0);

    // Test Hostile Action Notice Window (>50% import tariff delayed by 4 game days)
    const noticeRes = engine.setImportDutyWithNotice(3, 0.65, 1, 4);
    expect(noticeRes.appliedImmediately).toBe(false);
    expect(engine.getRegion(3).levers.importDutyRate).toBe(0.06);

    let r4TriggeredImf = false;

    for (let m = 1; m <= 36; m++) {
      if (m === 6) {
        // Dilutive state-funded upgrade on S1's steel mill
        engine.upgradeFactoryProject({
          sectorId: 1,
          projectId: "s1-mill",
          upgradeCostLocal: money(3_157_895),
          mayorPaysAll: true,
        });
        expect(p1.cityShare).toBeGreaterThan(0.60);
      }

      const reports = engine.stepMonth();
      expect(reports.length).toBe(5);

      for (const rep of reports) {
        expect(rep.invariants.valid).toBe(true);
        expect(rep.invariants.maxRowError).toBe(0n);
        expect(rep.invariants.maxColError).toBe(0n);
        expect(rep.invariants.cbColumnIndependentSum).toBe(0n);
        expect(rep.invariants.moneyDecompositionDiff).toBe(0n);
      }

      const r4 = reports.find((r) => r.sectorId === 4)!;
      if (r4.imfActive) r4TriggeredImf = true;
    }

    // Notice window has elapsed after month 1 (30 game days > 4 days)
    expect(engine.getRegion(3).levers.importDutyRate).toBe(0.65);
    // Populist R4 weakens currency & triggers IMF stabilisation facility (matching Sheet 08)
    expect(engine.getRegion(4).fxRatePerWcu).toBeGreaterThan(1.08);
    expect(r4TriggeredImf).toBe(true);
    // Sector 2 accumulated offshore SWF balance in WCU
    expect(engine.getRegion(2).swfBalanceWcu > 0n).toBe(true);

    // 48h AFK AI Governor takeover check
    const r1 = engine.getRegion(1);
    r1.mayorUid = "mayor-1";
    r1.lastMayorActivityEpochMs = 1_000_000;
    const switched = engine.evaluateAiGovernorTimeouts(1_000_000 + 49 * 3600 * 1000);
    expect(switched).toContain(1);
    expect(r1.isAiGovernor).toBe(true);

    // 1000-pt Hegemony Index sanity check
    const heg = computeHegemonyScores(
      ([1, 2, 3, 4, 5] as const).map((s) => {
        const rep = engine.getRegion(s).lastReport!;
        return {
          sectorId: s,
          gdpInWcu: rep.gdpWcu,
          swfAndReservesInWcu: toUnits(rep.fxReservesWcu + rep.swfBalanceWcu),
          megaprojectEquityShare: 0.2,
          households: rep.households,
          happinessIndex: rep.happinessIndex,
          avgLandValueUnits: 240_000,
          freightAndTransitVolumeTons: 50_000 * s,
          tier3And4OutputInWcu: 20_000_000 * s,
          avgProductQualityStars: 3.5,
        };
      })
    );
    expect(heg.length).toBe(5);
    expect(Math.max(...heg.map((h) => h.totalPoints))).toBeLessThanOrEqual(1000);
  });
});

describe("1000×1000 Peninsula Grid & Hybrid 90°/45° Network (Sprint 2 Core)", () => {
  test("generates 5 equalized sectors (~90k land tiles ±5%), Central Core, rivers, gateways & deposits", () => {
    const map = generatePeninsulaMap();
    expect(map.width).toBe(GRID_WIDTH);
    expect(map.height).toBe(GRID_HEIGHT);

    // Central Core diameter 120 => π * 60^2 ≈ 11,309 tiles
    expect(map.centralCoreTiles).toBeGreaterThan(11_200);
    expect(map.centralCoreTiles).toBeLessThan(11_400);
    expect(map.owner[500 * GRID_WIDTH + 500]).toBe(OwnerCode.CentralCore);

    // Each of the 5 sectors has ~90,000 buildable land tiles (within ±5% per GDD §2.1)
    for (const s of [1, 2, 3, 4, 5] as const) {
      const land = map.sectorLandTiles[s];
      expect(land).toBeGreaterThan(85_500);
      expect(land).toBeLessThan(94_500);
    }

    // 5 gateways (2 overland + 3 tunnels) & 25 resource deposits
    expect(map.gateways.length).toBe(5);
    expect(map.deposits.length).toBe(25);
    expect(CORE_RADIUS_TILES).toBe(60);

    // Verify freshwater river tiles exist in every sector
    const riverBySector: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (let i = 0; i < map.surface.length; i++) {
      if (map.surface[i] === SurfaceType.River) {
        riverBySector[map.owner[i]!] = (riverBySector[map.owner[i]!] ?? 0) + 1;
      }
    }
    for (const s of [1, 2, 3, 4, 5]) {
      expect(riverBySector[s]).toBeGreaterThan(100);
    }
  });

  test("validates 90° orthogonal & 45° diagonal roads, river bridge 3x cost, and rejects invalid angles", () => {
    const map = generatePeninsulaMap();

    // Orthogonal 2-lane street inside Sector 1 (10 tiles = 100 m = 0.1 km => $18,000)
    const ortho = validateAndQuoteNetworkSegment({
      map,
      sectorId: 1,
      kind: "street_2lane",
      fromX: 350,
      fromY: 250,
      toX: 360,
      toY: 250,
    });
    expect(ortho.ok).toBe(true);
    if (ortho.ok) {
      expect(ortho.preview.angleMode).toBe("ortho_90");
      expect(toUnits(ortho.preview.buildCostLocal)).toBeCloseTo(18_000, 0);
    }

    // 45° diagonal road across Sector 1's river loop (`y=290..330` around `x=340..380`)
    const diagBridge = validateAndQuoteNetworkSegment({
      map,
      sectorId: 1,
      kind: "street_2lane",
      fromX: 335,
      fromY: 300,
      toX: 365,
      toY: 330,
    });
    expect(diagBridge.ok).toBe(true);
    if (diagBridge.ok) {
      expect(diagBridge.preview.angleMode).toBe("diag_45");
      expect(diagBridge.preview.hasBridge).toBe(true);
      expect(diagBridge.preview.riverCrossingTiles).toBeGreaterThan(0);
    }

    // Non-45° arbitrary angle must be rejected
    const badAngle = validateAndQuoteNetworkSegment({
      map,
      sectorId: 1,
      kind: "street_2lane",
      fromX: 350,
      fromY: 250,
      toX: 360,
      toY: 255,
    });
    expect(badAngle.ok).toBe(false);

    // Snap helper produces valid 45° or 90° target
    const snapped = snapToHybridGrid45(350, 250, 362, 261);
    expect(Math.abs(snapped.toX - 350)).toBe(Math.abs(snapped.toY - 250));
  });
});
