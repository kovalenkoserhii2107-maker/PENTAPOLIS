/**
 * Road Physics — Speed Limits, Capacity, Axle-Load Wear & Repair (Sprint 5, GDD §5.2).
 *
 * Numbers come from sheet 23 `Logistics Hubs & Road Physics` (Road Classification table);
 * stage thresholds (74–40% potholes, <40% emergency) come from GDD §5.2.
 *
 * Wear model: every vehicle pass loads the pavement with `roadWearFactor` Equivalent Standard
 * Axle Loads (car = 1, heavy semi = 2,500, tipper = 2,800 — sheet 07). A road class loses its
 * sheet "Monthly Road Degradation Rate under Heavy Freight" when it carries the reference heavy
 * freight load (`HEAVY_FREIGHT_REFERENCE_ESAL_PER_HOUR`), scaled linearly with the actual load.
 */
import { parseCsv, parseNum } from "../csv.ts";
import { money, mulRate, type Money } from "../money/money.ts";
import { RAW_SHEETS } from "../catalogs/rawSheets.generated.ts";
import type { NetworkKind } from "../map/PeninsulaGrid.ts";

export type RoadKind = "street_2lane" | "avenue_4lane" | "express_6lane" | "heavy_bypass";

export const ROAD_KINDS: readonly RoadKind[] = [
  "street_2lane",
  "avenue_4lane",
  "express_6lane",
  "heavy_bypass",
];

export function isRoadKind(kind: NetworkKind): kind is RoadKind {
  return (ROAD_KINDS as readonly string[]).includes(kind);
}

export interface RoadClassSpec {
  readonly kind: RoadKind;
  readonly nameEn: string;
  readonly speedLimitKmh: number;
  readonly capacityVehiclesPerHour: number;
  readonly constructionCostPerKmUnits: number;
  readonly maintenancePerKmPerMonthUnits: number;
  readonly heavyTruckWearMultiplier: number;
  readonly monthlyDegradationUnderHeavyFreight: number; // fraction of health per game month, e.g. 0.085
  readonly speedPenaltyBelow40: number; // sheet value, e.g. -0.45 (informational, class resilience)
}

const ROAD_ROW_TO_KIND: ReadonlyArray<readonly [RegExp, RoadKind]> = [
  [/2-lane/i, "street_2lane"],
  [/4-lane/i, "avenue_4lane"],
  [/6-lane/i, "express_6lane"],
  [/heavy bypass/i, "heavy_bypass"],
];

export function parseRoadClassSheet(csvText: string): Map<RoadKind, RoadClassSpec> {
  const rows = parseCsv(csvText);
  const specs = new Map<RoadKind, RoadClassSpec>();
  const headerIdx = rows.findIndex((r) => (r[1] ?? "").trim() === "Road Classification");
  if (headerIdx < 0) return specs;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const name = (r[1] ?? "").trim();
    const match = ROAD_ROW_TO_KIND.find(([re]) => re.test(name));
    if (!match) break;
    specs.set(match[1], {
      kind: match[1],
      nameEn: name,
      speedLimitKmh: parseNum(r[2]),
      capacityVehiclesPerHour: parseNum(r[3]),
      constructionCostPerKmUnits: parseNum(r[4]),
      maintenancePerKmPerMonthUnits: parseNum(r[5]),
      heavyTruckWearMultiplier: parseNum(r[6]),
      monthlyDegradationUnderHeavyFreight: parseNum(r[7]),
      speedPenaltyBelow40: parseNum(r[8]),
    });
  }
  return specs;
}

let cachedRoadSpecs: Map<RoadKind, RoadClassSpec> | null = null;

export function getRoadClassSpecs(): ReadonlyMap<RoadKind, RoadClassSpec> {
  if (!cachedRoadSpecs) {
    cachedRoadSpecs = parseRoadClassSheet(RAW_SHEETS["Logistics Hubs & Road Physics"] ?? "");
    if (cachedRoadSpecs.size !== ROAD_KINDS.length) {
      throw new Error("Sheet 23 `Logistics Hubs & Road Physics` is missing road classification rows");
    }
  }
  return cachedRoadSpecs;
}

export function getRoadClassSpec(kind: RoadKind): RoadClassSpec {
  return getRoadClassSpecs().get(kind)!;
}

/** Metro trains and rail run on their own track speeds (sheet 07: metro 80 km/h, freight rail 80–100). */
export function trackSpeedLimitKmh(kind: NetworkKind): number {
  if (isRoadKind(kind)) return getRoadClassSpec(kind).speedLimitKmh;
  if (kind === "metro_tunnel") return 80;
  if (kind === "rail") return 100;
  return 0;
}

/**
 * A steady stream of 10 heavy semis per hour (10 × 2,500 ESAL) is the "heavy freight" load at which
 * a road loses its sheet-23 monthly degradation rate; lighter loads scale linearly.
 */
export const HEAVY_FREIGHT_REFERENCE_ESAL_PER_HOUR = 25_000;
/** Rain, frost and sun: background ageing of any paved road, % health per game month. */
export const BASE_WEATHERING_PERCENT_PER_MONTH = 0.4;
/** `TRUCK_WEIGHT_CONTROL` decree: −25% wear (GDD §5.2, §6.6). */
export const TRUCK_WEIGHT_CONTROL_WEAR_MULTIPLIER = 0.75;
export const GAME_HOURS_PER_MONTH = 720;
/** Pavement never drops below this; it is impassable rubble only in name. */
export const MIN_ROAD_HEALTH_PERCENT = 5;

export type RoadConditionStage = "good" | "potholes" | "emergency";

/** GDD §5.2: 74–40% potholes & ruts, below 40% emergency condition. */
export function roadConditionStage(healthPercent: number): RoadConditionStage {
  if (healthPercent >= 75) return "good";
  if (healthPercent >= 40) return "potholes";
  return "emergency";
}

/**
 * Speed multiplier from pavement health (GDD §5.2): potholes slow traffic by 30% (at 74%)
 * up to 45% (at 40%); emergency condition (<40%) slows it by 70%.
 */
export function roadHealthSpeedFactor(healthPercent: number): number {
  const stage = roadConditionStage(healthPercent);
  if (stage === "good") return 1;
  if (stage === "potholes") {
    const depth = (74 - Math.min(74, healthPercent)) / 34;
    return 1 - (0.3 + 0.15 * depth);
  }
  return 0.3;
}

/** BPR volume-delay function: travel time multiplier at a volume/capacity ratio. */
export function congestionTravelTimeFactor(volumeCapacityRatio: number): number {
  const vc = Math.max(0, volumeCapacityRatio);
  return 1 + 0.15 * vc ** 4;
}

/**
 * Health percent lost per game hour by a road segment under `esalPerHour` axle loads.
 */
export function roadWearPercentPerHour(params: {
  kind: RoadKind;
  esalPerHour: number;
  truckWeightControl: boolean;
}): number {
  const spec = getRoadClassSpec(params.kind);
  const freightLoss =
    spec.monthlyDegradationUnderHeavyFreight *
    100 *
    (params.esalPerHour / HEAVY_FREIGHT_REFERENCE_ESAL_PER_HOUR) *
    (params.truckWeightControl ? TRUCK_WEIGHT_CONTROL_WEAR_MULTIPLIER : 1);
  return (freightLoss + BASE_WEATHERING_PERCENT_PER_MONTH) / GAME_HOURS_PER_MONTH;
}

/** Health percent a single pass of a vehicle with `roadWearFactor` takes off a road. */
export function roadWearPercentPerPass(kind: RoadKind, roadWearFactor: number): number {
  const spec = getRoadClassSpec(kind);
  return (
    (spec.monthlyDegradationUnderHeavyFreight * 100 * roadWearFactor) /
    (HEAVY_FREIGHT_REFERENCE_ESAL_PER_HOUR * GAME_HOURS_PER_MONTH)
  );
}

/** Road Service budget levels (mayor lever): none / standard / reinforced. */
export type RoadServiceLevel = 0 | 1 | 2;

export const ROAD_SERVICE_RESTORE_PERCENT_PER_MONTH: Readonly<Record<RoadServiceLevel, number>> = {
  0: 0,
  1: 1.5,
  2: 4.5,
};

export const ROAD_SERVICE_COST_MULTIPLIER: Readonly<Record<RoadServiceLevel, number>> = {
  0: 0,
  1: 1,
  2: 2.4,
};

/** Monthly Road Service bill for a road (sheet 23 maintenance base × service level), in WCU minor units. */
export function roadServiceMonthlyCost(kind: RoadKind, lengthMeters: number, level: RoadServiceLevel): Money {
  const spec = getRoadClassSpec(kind);
  return money(
    (lengthMeters / 1000) * spec.maintenancePerKmPerMonthUnits * ROAD_SERVICE_COST_MULTIPLIER[level]
  );
}

/** Resurfacing restores a road to 100%: half of construction cost per km × missing health share. */
export function roadRepairCost(kind: RoadKind, lengthMeters: number, healthPercent: number, fxRatePerWcu = 1): Money {
  const spec = getRoadClassSpec(kind);
  const missing = Math.max(0, Math.min(100, 100 - healthPercent)) / 100;
  return mulRate(money((lengthMeters / 1000) * spec.constructionCostPerKmUnits * 0.5 * missing), fxRatePerWcu);
}
