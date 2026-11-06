/**
 * Citizen Car Lifecycle: Dealership -> Trade-In -> Used Lot -> Repair Shop (СТО) -> Scrap
 * (Sprint 6, GDD §6.4, sheet 25 Table 3).
 *
 * Each sector keeps a fleet split into the 5 sheet stages. Cars age with the citizen calendar
 * (1 game month = 1 year of life, GDD §1.4), so a car moves down the stages within days of real
 * time. New households buy cars; affluent districts buy new at the dealership (BIZ-07, otherwise
 * imported at a premium) and trade in their old ones at the used-car lot (BIZ-08). Breakdowns
 * follow each stage's risk, worsened by potholes; private repair shops (BIZ-01) fix what their
 * capacity allows. End-of-life cars yield 1.2 t of scrap each for the scrapyard (UTL-05).
 */
import { parseCsv, parseNum } from "../csv.ts";
import { RAW_SHEETS } from "../catalogs/rawSheets.generated.ts";
import type { MasterCatalogs } from "../catalogs/index.ts";
import { computeBuildingAtLevel } from "../catalogs/buildings.ts";
import type { SectorId } from "../catalogs/visuals.ts";
import type { BuildingDto, SectorAutoStatsDto } from "../protocol.ts";

export interface CarStageSpec {
  readonly stage: 1 | 2 | 3 | 4 | 5;
  readonly nameEn: string;
  readonly ageYears: readonly [number, number];
  readonly marketPriceUnits: number;
  readonly maintenancePerMonthUnits: number;
  readonly breakdownRiskPerMonth: number;
}

export const CAR_STAGE_NAMES_RU: Readonly<Record<1 | 2 | 3 | 4 | 5, string>> = {
  1: "Новые (автосалон)",
  2: "Trade-In / сертифицированные",
  3: "Б/у площадки",
  4: "Старые (СТО)",
  5: "Металлолом",
};

export const SCRAP_TONS_PER_CAR = 1.2;
/** Cars per household when the fleet is saturated (sheet 25 header: ~185k cars / ~300k households). */
export const CARS_PER_HOUSEHOLD = 0.62;
/** Average repair ticket at an independent repair shop ($). */
export const AVERAGE_REPAIR_TICKET_UNITS = 250;
/** Share of the saturated fleet that households can add in one game month. */
export const MAX_FLEET_GROWTH_PER_MONTH = 0.35;
/** Imported new cars cost more without a local dealership. */
export const IMPORTED_CAR_PREMIUM = 0.3;

export function parseCarStageTable(csvText: string): CarStageSpec[] {
  const rows = parseCsv(csvText);
  const start = rows.findIndex((r) => (r[1] ?? "").startsWith("Table 3"));
  const out: CarStageSpec[] = [];
  for (let i = start + 1; i < rows.length && out.length < 5; i++) {
    const r = rows[i]!;
    const m = /^Stage (\d)/.exec((r[1] ?? "").trim());
    if (!m) continue;
    const ages = /(\d+)\s*[–-]\s*(\d+)/.exec(r[2] ?? "");
    const plus = /(\d+)\+/.exec(r[2] ?? "");
    out.push({
      stage: Number(m[1]) as CarStageSpec["stage"],
      nameEn: (r[1] ?? "").replace(/^Stage \d:\s*/, "").trim(),
      ageYears: ages ? [Number(ages[1]), Number(ages[2])] : [Number(plus?.[1] ?? 20), Number(plus?.[1] ?? 20)],
      marketPriceUnits: parseNum(r[3]),
      maintenancePerMonthUnits: parseNum(r[4]),
      breakdownRiskPerMonth: parseNum(r[5]),
    });
  }
  return out;
}

let cachedStages: CarStageSpec[] | null = null;

export function getCarStages(): readonly CarStageSpec[] {
  if (!cachedStages) {
    cachedStages = parseCarStageTable(RAW_SHEETS["Urban Micro-Economy & Auto"] ?? "");
    if (cachedStages.length !== 5) throw new Error("Sheet 25 Table 3 (car lifecycle) is incomplete");
  }
  return cachedStages;
}

/** Persistent fleet of one sector: cars per stage (fractional for smooth daily flows). */
export interface SectorFleetState {
  readonly sectorId: SectorId;
  fleet: [number, number, number, number, number];
}

export interface AutoMarketInput {
  readonly catalogs: MasterCatalogs;
  readonly fleets: readonly SectorFleetState[];
  readonly buildings: readonly BuildingDto[];
  /** Physical households per sector (built residential zones). */
  readonly households: ReadonlyMap<SectorId, number>;
  /** Share of households in tiers 4–5 (they buy new cars). */
  readonly affluentShare: ReadonlyMap<SectorId, number>;
  readonly avgRoadHealth: ReadonlyMap<SectorId, number>;
  /** Share (0..1) of sector roads with healthPercent < 75% — drives suspension & tire breakdowns. */
  readonly damagedRoadShare?: ReadonlyMap<SectorId, number>;
  /** Fraction of a game month simulated (1 day = 1/30). */
  readonly months: number;
}

/**
 * Advances every sector's fleet by `months` and returns the flows of that step scaled to a full
 * month for display. Mutates the fleet states in place.
 */
export function runAutoMarket(input: AutoMarketInput): SectorAutoStatsDto[] {
  const stages = getCarStages();
  const { catalogs } = input;
  const out: SectorAutoStatsDto[] = [];
  const months = Math.max(0, input.months);

  for (const st of input.fleets) {
    const sid = st.sectorId;
    const ops = input.buildings.filter((b) => b.sectorId === sid && b.constructionProgress >= 1 && !b.stalledAwaitingPrivate);
    const count = (id: string) => ops.filter((b) => b.catalogId === id);
    const dealership = count("BIZ-07").length > 0;
    const usedLot = count("BIZ-08").length > 0;
    const stoBays = count("BIZ-01");
    const scrapyards = [...count("UTL-05"), ...count("UTL-04")];
    const capacityOf = (list: BuildingDto[]) =>
      list.reduce((s, b) => {
        const e = catalogs.buildingsById.get(b.catalogId);
        return s + (e ? computeBuildingAtLevel(e, catalogs.levelCurves, b.level).capacity : 0);
      }, 0);
    const repairCapacityPerMonth = capacityOf(stoBays) / AVERAGE_REPAIR_TICKET_UNITS;
    const scrapCapacityTonsPerMonth = capacityOf(scrapyards);

    const f = st.fleet;
    // Ageing: 1 game month = 1 year of life; a stage spanning N years releases 1/N of its cars a month
    const flows = [0, 0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const [a, b] = stages[i]!.ageYears;
      const years = Math.max(1, b - a + 1);
      flows[i] = f[i]! * Math.min(1, months / years);
    }
    for (let i = 3; i >= 0; i--) {
      f[i] = f[i]! - flows[i]!;
      f[i + 1] = f[i + 1]! + flows[i]!;
    }
    // Scrapyard dismantles end-of-life cars (they leave the fleet either way)
    const scrapped = f[4];
    f[4] = 0;
    const scrapTons = scrapped * SCRAP_TONS_PER_CAR;
    const recycledTons = Math.min(scrapTons, scrapCapacityTonsPerMonth * months);

    // New households and scrapped cars create demand; affluent districts buy new
    const target = (input.households.get(sid) ?? 0) * CARS_PER_HOUSEHOLD;
    const fleetNow = f.reduce((s, v) => s + v, 0);
    // Households replace scrapped cars at once but build up a new fleet over a few months
    const purchases = Math.min(Math.max(0, target - fleetNow), scrapped + target * MAX_FLEET_GROWTH_PER_MONTH * months);
    const affluent = Math.max(0.15, input.affluentShare.get(sid) ?? 0);
    const newCars = purchases * affluent;
    // Others buy second-hand: trade-ins offered at the used lot, or the cheapest old cars
    const usedCars = purchases - newCars;
    f[0] += newCars;
    if (usedLot) f[1] += usedCars;
    else f[2] += usedCars;

    // Breakdowns, worsened by potholes & share of roads with healthPercent < 75% (GDD §6.4)
    const healthDeficit = 1 - Math.min(100, input.avgRoadHealth.get(sid) ?? 100) / 100;
    const damagedShare = Math.max(0, Math.min(1, input.damagedRoadShare?.get(sid) ?? 0));
    const roadFactor = 1 + Math.max(healthDeficit, damagedShare * 1.2) * 1.5;
    const breakdowns = f.slice(0, 4).reduce((s, n, i) => s + n * stages[i]!.breakdownRiskPerMonth, 0) * roadFactor * months;
    const repaired = Math.min(breakdowns, repairCapacityPerMonth * months);

    const perMonth = (v: number) => (months > 0 ? v / months : 0);
    const fleetTotal = f.reduce((s, v) => s + v, 0);
    const avgPrice = fleetTotal > 0 ? f.reduce((s, n, i) => s + n * stages[i]!.marketPriceUnits, 0) / fleetTotal : 0;
    out.push({
      sectorId: sid,
      fleetByStage: f.map((v) => Math.round(v)),
      targetFleet: Math.round(target),
      dealership,
      usedLot,
      repairShops: stoBays.length,
      scrapyards: scrapyards.length,
      newCarsPerMonth: Math.round(perMonth(newCars)),
      newCarsImported: !dealership,
      newCarPriceUnits: Math.round(stages[0]!.marketPriceUnits * (dealership ? 1 : 1 + IMPORTED_CAR_PREMIUM)),
      breakdownsPerMonth: Math.round(perMonth(breakdowns)),
      repairedPerMonth: Math.round(perMonth(repaired)),
      strandedPerMonth: Math.round(perMonth(breakdowns - repaired)),
      scrapTonsPerMonth: Number(perMonth(scrapTons).toFixed(1)),
      scrapRecycledTonsPerMonth: Number(perMonth(recycledTons).toFixed(1)),
      avgCarValueUnits: Math.round(avgPrice),
    });
  }
  return out;
}
