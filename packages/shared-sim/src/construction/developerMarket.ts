/**
 * Private Developers & the Construction Materials Market (Sprint 4, GDD §6.1, §4.4).
 *
 * Zones are not built by decree: private developers raise buildings lot by lot and must physically
 * buy materials for every tile (sheet 20 `Demographics & State Budget`, Table 5):
 * - low density (cottages, corner shops): Lumber + Limestone & Granite only — no steel, no prefabs,
 *   so a day-1 city can always start (GDD §6.1 "защита от тупика 1-го дня");
 * - medium density: Cement + Steel + Lumber;
 * - high density: Construction Prefabs + Steel + Cement + Lumber.
 *
 * Purchase cascade (GDD §4.4, Contour A): the sector's own operational plants first, then imports
 * from the External World through the starter gateway (2 narrow lanes: capped tonnage, freight
 * premium, import duty to the treasury). A missing material stalls the sites that need it.
 */
import { parseCsv, parseNum } from "../csv.ts";
import { RAW_SHEETS } from "../catalogs/rawSheets.generated.ts";
import type { MasterCatalogs } from "../catalogs/index.ts";
import { computeBuildingAtLevel } from "../catalogs/buildings.ts";
import type { SectorId } from "../catalogs/visuals.ts";
import type { ZoneKind } from "../map/PeninsulaGrid.ts";
import { money, mulRate, type Money } from "../money/money.ts";
import type { BuildingDto, SectorConstructionStatsDto, ZoneDto } from "../protocol.ts";

export const CONSTRUCTION_MATERIALS = [
  "Lumber",
  "Limestone & Granite",
  "Cement",
  "Steel",
  "Construction Prefabs",
] as const;
export type ConstructionMaterial = (typeof CONSTRUCTION_MATERIALS)[number];

export const MATERIAL_NAMES_RU: Readonly<Record<ConstructionMaterial, string>> = {
  Lumber: "Пиломатериалы",
  "Limestone & Granite": "Камень и гранит",
  Cement: "Цемент",
  Steel: "Сталь",
  "Construction Prefabs": "Стройпрефабы",
};

/** Tons in one accounting unit of a commodity (prefab modules are bulky precast elements). */
export function commodityUnitTons(unit: string): number {
  const u = unit.trim().toLowerCase();
  if (u === "t" || u.startsWith("t ") || u.includes("ton")) return 1;
  if (u.includes("pallet")) return 0.1;
  if (u.includes("machine")) return 5;
  if (u.includes("batch")) return 0.2;
  if (u.includes("module")) return 8;
  if (u.includes("set")) return 0.5;
  if (u.includes("vehicle")) return 12;
  if (u.includes("car")) return 1.3;
  if (u.includes("crate")) return 0.3;
  return 1;
}

export interface ZoneMaterialSpec {
  readonly zoneKind: ZoneKind;
  readonly phaseRu: string;
  readonly tonsPerTile: Readonly<Record<ConstructionMaterial, number>>;
  readonly capexPerTileUnits: number;
}

const TABLE5_ROWS: ReadonlyArray<readonly [RegExp, ZoneKind]> = [
  [/^low-density residential/i, "RES-01"],
  [/^medium-density residential/i, "RES-02"],
  [/^high-density residential/i, "RES-03"],
  [/^low-density commercial/i, "COM-01"],
  [/^medium-density commercial/i, "COM-02"],
  [/^high-density commercial/i, "COM-03"],
  [/^medium-density office/i, "OFF-01"],
  [/^high-density office/i, "OFF-02"],
];

/** Parses sheet 20 Table 5 (developer material sink per tile). */
export function parseZoneMaterialTable(csvText: string): Map<ZoneKind, ZoneMaterialSpec> {
  const rows = parseCsv(csvText);
  const specs = new Map<ZoneKind, ZoneMaterialSpec>();
  const start = rows.findIndex((r) => (r[1] ?? "").startsWith("TABLE 5"));
  if (start < 0) return specs;
  for (let i = start + 2; i < rows.length; i++) {
    const r = rows[i]!;
    const name = (r[1] ?? "").trim();
    const match = TABLE5_ROWS.find(([re]) => re.test(name));
    if (!match) {
      if (name.startsWith("TABLE")) break;
      continue;
    }
    specs.set(match[1], {
      zoneKind: match[1],
      phaseRu: (r[2] ?? "").trim(),
      tonsPerTile: {
        Cement: parseNum(r[3]),
        Steel: parseNum(r[4]),
        Lumber: parseNum(r[5]),
        "Construction Prefabs": parseNum(r[6]),
        "Limestone & Granite": parseNum(r[9]),
      },
      capexPerTileUnits: parseNum(r[8]),
    });
  }
  return specs;
}

let cachedSpecs: Map<ZoneKind, ZoneMaterialSpec> | null = null;

export function getZoneMaterialSpecs(): ReadonlyMap<ZoneKind, ZoneMaterialSpec> {
  if (!cachedSpecs) {
    cachedSpecs = parseZoneMaterialTable(RAW_SHEETS["Demographics & State Budget"] ?? "");
    if (cachedSpecs.size !== TABLE5_ROWS.length) {
      throw new Error("Sheet 20 Table 5 (developer materials per tile) is incomplete");
    }
  }
  return cachedSpecs;
}

/** Parallel developer crews per zone: a zone fills in `buildTime / crews` game hours at best. */
export const DEVELOPER_PARALLEL_CREWS = 2;
/** Happiness below 50 cools the developer market (GDD §6.7). */
export const LOW_HAPPINESS_GROWTH_FACTOR = 0.35;
/** Starter gateway (2 narrow lanes) import cap for bulk construction materials. */
export const STARTER_GATEWAY_IMPORT_TONS_PER_HOUR = 120;
/** External World freight premium on imported materials (GDD §2.2: "высокий тариф фрахта"). */
export const IMPORT_FREIGHT_PREMIUM = 0.35;
/** New dwellings per residential tile as it is built (households of 2.2 persons). */
export const DWELLINGS_PER_RESIDENTIAL_TILE: Readonly<Record<string, number>> = {
  "RES-01": 1.5,
  "RES-02": 5,
  "RES-03": 12,
};

const PLANT_FOR_MATERIAL: Readonly<Record<ConstructionMaterial, string>> = {
  Lumber: "PRO-06",
  "Limestone & Granite": "EXT-04",
  Cement: "PRO-04",
  Steel: "PRO-01",
  "Construction Prefabs": "CMP-04",
};

export interface DeveloperSectorInput {
  readonly sectorId: SectorId;
  readonly happinessIndex: number;
  readonly importDutyRate: number;
  readonly fxRatePerWcu: number;
  /** The starter gateway is connected to the sector's own road network. */
  readonly gatewayConnected: boolean;
}

export interface DeveloperMarketInput {
  readonly catalogs: MasterCatalogs;
  readonly zones: readonly ZoneDto[];
  readonly buildings: readonly BuildingDto[];
  readonly sectors: readonly DeveloperSectorInput[];
  readonly hours: number;
  /** Per-zone district happiness 0..100 (Sprint 6); overrides the sector happiness when present. */
  readonly districtHappiness?: ReadonlyMap<string, number>;
  /** Output multiplier of gasified plants (Sprint 7). */
  readonly plantOutputMultiplier?: ReadonlyMap<string, number>;
  /** Buyer/seller pairs linked by an open border post (Sprint 7). */
  readonly tradePartners?: readonly MaterialTradePartner[];
}

export interface MaterialTradePartner {
  readonly buyer: SectorId;
  readonly seller: SectorId;
  readonly allowed: (material: ConstructionMaterial) => boolean;
  readonly importDuty: (material: ConstructionMaterial) => number;
  readonly exportDuty: (material: ConstructionMaterial) => number;
}

/** GDD §6.7: arrivals scale with (H / 70)²; developers follow demand. */
export function districtDemandFactor(happiness: number): number {
  return Math.max(0.2, Math.min(1.3, (happiness / 70) ** 2));
}

export interface ZoneGrowthResult {
  readonly zoneId: string;
  readonly occupancyBefore: number;
  readonly occupancyAfter: number;
  /** Share of the desired construction the market could supply (0 = stalled, 1 = unconstrained). */
  readonly fillRatio: number;
  readonly limitingMaterial: ConstructionMaterial | null;
  readonly dwellingsAdded: number;
}

export interface DeveloperMarketResult {
  readonly zones: readonly ZoneGrowthResult[];
  readonly sectors: readonly SectorConstructionStatsDto[];
  /** Customs duty (gateway imports, border imports and exports) collected by each treasury over the step (local minor units). */
  readonly importDutyBySector: ReadonlyMap<SectorId, Money>;
}

function materialPricePerTonWcu(catalogs: MasterCatalogs, m: ConstructionMaterial): Money {
  const recipe = catalogs.commoditiesByName.get(m);
  if (!recipe) return 0n;
  return mulRate(recipe.worldReferencePrice, 1 / commodityUnitTons(recipe.accountingUnit));
}

/**
 * Advances developer construction on every zone by `hours` game hours. Materials come from the
 * sector's own plants first, then a neighbour's spare output through open border posts (Sprint 7,
 * GDD §4.4 priority 2), then External World imports through the gateway. Pure and deterministic.
 */
export function runDeveloperMarket(input: DeveloperMarketInput): DeveloperMarketResult {
  const { catalogs } = input;
  const specs = getZoneMaterialSpecs();
  const hours = Math.max(0, input.hours);
  const zoneResults: ZoneGrowthResult[] = [];
  const sectorStats: SectorConstructionStatsDto[] = [];
  const dutyBySector = new Map<SectorId, Money>();
  const addDuty = (sid: SectorId, v: Money) => dutyBySector.set(sid, (dutyBySector.get(sid) ?? 0n) + v);
  const zeroMap = () => new Map<ConstructionMaterial, number>(CONSTRUCTION_MATERIALS.map((m) => [m, 0]));
  const fxOf = new Map(input.sectors.map((s) => [s.sectorId, s.fxRatePerWcu]));

  // Pass 1: local supply, desired construction and what the sector's own plants cover
  const plans = input.sectors.map((sec) => {
    const localTph = zeroMap();
    for (const b of input.buildings) {
      if (b.sectorId !== sec.sectorId || b.constructionProgress < 1 || b.stalledAwaitingPrivate) continue;
      const m = CONSTRUCTION_MATERIALS.find((mat) => PLANT_FOR_MATERIAL[mat] === b.catalogId);
      if (!m) continue;
      const entry = catalogs.buildingsById.get(b.catalogId);
      if (!entry) continue;
      const stats = computeBuildingAtLevel(entry, catalogs.levelCurves, b.level);
      const gas = input.plantOutputMultiplier?.get(b.id) ?? 1;
      localTph.set(m, localTph.get(m)! + stats.capacity * commodityUnitTons(entry.capacityUnit) * gas);
    }

    const growthFactor = sec.happinessIndex >= 50 ? 1 : LOW_HAPPINESS_GROWTH_FACTOR;
    const desired = input.zones
      .filter((z) => z.sectorId === sec.sectorId)
      .map((z) => {
        const spec = specs.get(z.zoneKind);
        const districtH = input.districtHappiness?.get(z.id);
        const zoneFactor = districtH === undefined ? growthFactor : districtDemandFactor(districtH);
        const entry = catalogs.buildingsById.get(z.zoneKind);
        const buildHours = Math.max(1, entry?.buildTimeGameHours ?? 48);
        const dOcc = Math.max(0, Math.min(1 - z.occupancyRatio, (DEVELOPER_PARALLEL_CREWS / buildHours) * hours * zoneFactor));
        const tiles = z.width * z.depth;
        const demand = new Map<ConstructionMaterial, number>();
        for (const m of CONSTRUCTION_MATERIALS) demand.set(m, dOcc * tiles * (spec?.tonsPerTile[m] ?? 0));
        return { z, dOcc, tiles, demand };
      });

    const totalDemand = new Map<ConstructionMaterial, number>(
      CONSTRUCTION_MATERIALS.map((m) => [m, desired.reduce((s, d) => s + d.demand.get(m)!, 0)])
    );
    const localAlloc = zeroMap();
    const residual = zeroMap();
    const surplus = zeroMap();
    for (const m of CONSTRUCTION_MATERIALS) {
      const local = Math.min(totalDemand.get(m)!, localTph.get(m)! * hours);
      localAlloc.set(m, local);
      residual.set(m, totalDemand.get(m)! - local);
      surplus.set(m, localTph.get(m)! * hours - local);
    }
    return { sec, localTph, desired, totalDemand, localAlloc, residual, surplus, neighborAlloc: zeroMap() };
  });
  const planOf = new Map(plans.map((p) => [p.sec.sectorId, p]));

  // Pass 2: neighbours' spare output across open border posts, with duties on both sides
  for (const partner of input.tradePartners ?? []) {
    const buyer = planOf.get(partner.buyer);
    const seller = planOf.get(partner.seller);
    if (!buyer || !seller) continue;
    for (const m of CONSTRUCTION_MATERIALS) {
      if (!partner.allowed(m)) continue;
      const take = Math.min(buyer.residual.get(m)!, seller.surplus.get(m)!);
      if (take <= 0) continue;
      buyer.residual.set(m, buyer.residual.get(m)! - take);
      buyer.neighborAlloc.set(m, buyer.neighborAlloc.get(m)! + take);
      seller.surplus.set(m, seller.surplus.get(m)! - take);
      const priceWcu = materialPricePerTonWcu(catalogs, m);
      addDuty(partner.buyer, mulRate(mulRate(priceWcu, (fxOf.get(partner.buyer) ?? 1) * partner.importDuty(m)), take));
      addDuty(partner.seller, mulRate(mulRate(priceWcu, (fxOf.get(partner.seller) ?? 1) * partner.exportDuty(m)), take));
    }
  }

  // Pass 3: gateway imports share one tonnage cap; each site advances as far as its scarcest material allows
  for (const plan of plans) {
    const { sec, desired, totalDemand, localAlloc, neighborAlloc, residual, localTph } = plan;
    const importCap = sec.gatewayConnected ? STARTER_GATEWAY_IMPORT_TONS_PER_HOUR * hours : 0;
    const residualTotal = CONSTRUCTION_MATERIALS.reduce((s, m) => s + residual.get(m)!, 0);
    const importShare = residualTotal > 0 ? Math.min(1, importCap / residualTotal) : 1;
    const fill = new Map<ConstructionMaterial, number>();
    for (const m of CONSTRUCTION_MATERIALS) {
      const demand = totalDemand.get(m)!;
      const supplied = localAlloc.get(m)! + neighborAlloc.get(m)! + residual.get(m)! * importShare;
      fill.set(m, demand > 0 ? Math.min(1, supplied / demand) : 1);
    }

    const consumed = zeroMap();
    let activeSites = 0;
    let stalledSites = 0;
    for (const d of desired) {
      let zoneFill = 1;
      let limiting: ConstructionMaterial | null = null;
      for (const m of CONSTRUCTION_MATERIALS) {
        if (d.demand.get(m)! <= 0) continue;
        if (fill.get(m)! < zoneFill) {
          zoneFill = fill.get(m)!;
          limiting = m;
        }
      }
      const grow = d.dOcc * zoneFill;
      for (const m of CONSTRUCTION_MATERIALS) consumed.set(m, consumed.get(m)! + d.demand.get(m)! * zoneFill);
      if (d.z.occupancyRatio < 1) {
        if (zoneFill < 0.05 && d.dOcc > 0) stalledSites += 1;
        else activeSites += 1;
      }
      const after = Math.min(1, d.z.occupancyRatio + grow);
      zoneResults.push({
        zoneId: d.z.id,
        occupancyBefore: d.z.occupancyRatio,
        occupancyAfter: after,
        fillRatio: Number(zoneFill.toFixed(3)),
        limitingMaterial: zoneFill < 0.999 ? limiting : null,
        dwellingsAdded: (after - d.z.occupancyRatio) * d.tiles * (DWELLINGS_PER_RESIDENTIAL_TILE[d.z.zoneKind] ?? 0),
      });
    }

    // Report rates; gateway duty on what was actually imported (local, then neighbour, then import)
    let gatewayDuty = 0n;
    let demandTph = 0;
    let suppliedTph = 0;
    const perHour = (t: number) => (hours > 0 ? t / hours : 0);
    const materials = CONSTRUCTION_MATERIALS.map((m) => {
      const used = consumed.get(m)!;
      const local = Math.min(used, localAlloc.get(m)!);
      const neighbor = Math.min(used - local, neighborAlloc.get(m)!);
      const imported = Math.max(0, used - local - neighbor);
      const priceWcu = materialPricePerTonWcu(catalogs, m);
      const localPrice = mulRate(priceWcu, sec.fxRatePerWcu);
      const importPrice = mulRate(localPrice, (1 + IMPORT_FREIGHT_PREMIUM) * (1 + sec.importDutyRate));
      gatewayDuty += mulRate(mulRate(localPrice, sec.importDutyRate), imported);
      demandTph += perHour(totalDemand.get(m)!);
      suppliedTph += perHour(used);
      return {
        material: m,
        nameRu: MATERIAL_NAMES_RU[m],
        demandTonsPerHour: Number(perHour(totalDemand.get(m)!).toFixed(2)),
        localTonsPerHour: Number(perHour(local).toFixed(2)),
        neighborTonsPerHour: Number(perHour(neighbor).toFixed(2)),
        importedTonsPerHour: Number(perHour(imported).toFixed(2)),
        localCapacityTonsPerHour: Number(localTph.get(m)!.toFixed(2)),
        shortfallTonsPerHour: Number(Math.max(0, perHour(totalDemand.get(m)! - used)).toFixed(2)),
        localPricePerTonMinor: localPrice.toString(),
        importPricePerTonMinor: importPrice.toString(),
      };
    });
    addDuty(sec.sectorId, gatewayDuty);

    sectorStats.push({
      sectorId: sec.sectorId,
      gatewayImportOpen: sec.gatewayConnected,
      importCapTonsPerHour: sec.gatewayConnected ? STARTER_GATEWAY_IMPORT_TONS_PER_HOUR : 0,
      demandTonsPerHour: Number(demandTph.toFixed(2)),
      fillRatio: demandTph > 0 ? Number((suppliedTph / demandTph).toFixed(3)) : 1,
      activeSites,
      stalledSites,
      materials,
      importDutyMinor: (dutyBySector.get(sec.sectorId) ?? 0n).toString(),
    });
  }

  return { zones: zoneResults, sectors: sectorStats, importDutyBySector: dutyBySector };
}

/** Material bill of a fully built zone, for the UI before painting (WCU minor units at local prices). */
export function zoneMaterialBill(zoneKind: ZoneKind, tiles: number): { tons: number; capexWcu: Money } {
  const spec = getZoneMaterialSpecs().get(zoneKind);
  if (!spec) return { tons: 0, capexWcu: 0n };
  const tons = CONSTRUCTION_MATERIALS.reduce((s, m) => s + spec.tonsPerTile[m], 0) * tiles;
  return { tons, capexWcu: money(spec.capexPerTileUnits * tiles) };
}
