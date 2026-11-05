/**
 * Units, Dual Calendars, 5-Tier Tick Cascade & Commodity Units (Sheet 01: `Units & Time`).
 */
import { parseCsv, parseNum } from "../csv.ts";
import { money, type Money } from "../money/money.ts";

export interface TimeBaseConfig {
  readonly realSecondsPerGameHour: number;
  readonly gameHoursPerGameDay: number;
  readonly gameDaysPerGameMonth: number;
  readonly gameHoursPerGameMonth: number;
  readonly realHoursPerGameMonth: number;
  readonly gameMonthsPerGameYear: number;
  readonly realDaysPerGameYear: number;
  readonly realDaysPerCitizenLifeYear: number;
  readonly citizenLifeYearsPerGameMonth: number;
  readonly serverMicroTickRealSeconds: number;
  readonly gameSecondsPerMicroTick: number;
  readonly seasonLengthDays: number;
  readonly noticeWindowMinGameDays: number;
  readonly noticeWindowMaxGameDays: number;
  readonly aiGovernorAfkHours: number;
}

export type CommodityTier = "Tier 1" | "Tier 2" | "Tier 3" | "Tier 4" | "Utility";

export interface CommodityUnitSpec {
  readonly name: string;
  readonly tier: CommodityTier;
  readonly accountingUnit: string;
  readonly massTonsPerUnit: number;
  readonly cargoClass: string;
  readonly outputPerGameHourLv1: number;
  readonly outputPerGameMonthLv1: number;
}

export interface InfrastructureDefaults {
  readonly localStreet2LaneCostPerKm: Money;
  readonly heavyRailCostPerKm: Money;
  readonly trunkPipelineCostPerKm: Money;
  readonly compressorStationCost: Money;
  readonly pipelineCapacityStandardPerHour: number;
  readonly pipelineCapacityBoostedPerHour: number;
  readonly hvPowerLineCostPerKm: Money;
  readonly substationCost: Money;
  readonly hvPowerLineCapacityMw: number;
}

export interface UnitsAndTimeCatalog {
  readonly timeBase: TimeBaseConfig;
  readonly commodityUnits: readonly CommodityUnitSpec[];
  readonly infrastructure: InfrastructureDefaults;
}

export function parseUnitsAndTimeSheet(csvText: string): UnitsAndTimeCatalog {
  const rows = parseCsv(csvText);
  const paramMap = new Map<string, number>();

  for (let i = 4; i < 18 && i < rows.length; i++) {
    const r = rows[i]!;
    const key = (r[1] ?? "").trim();
    if (key && key !== "Parameter" && key !== "Accounting rule") {
      paramMap.set(key, parseNum(r[2]));
    }
  }

  const timeBase: TimeBaseConfig = {
    realSecondsPerGameHour: paramMap.get("Real seconds per game hour") ?? 120,
    gameHoursPerGameDay: paramMap.get("Game hours per game day") ?? 24,
    gameDaysPerGameMonth: paramMap.get("Game days per game month") ?? 30,
    gameHoursPerGameMonth: paramMap.get("Game hours per game month") ?? 720,
    realHoursPerGameMonth: paramMap.get("Real hours per game month") ?? 24,
    gameMonthsPerGameYear: paramMap.get("Game months per game year") ?? 12,
    realDaysPerGameYear: paramMap.get("Real days per game year") ?? 12,
    realDaysPerCitizenLifeYear:
      paramMap.get("Real days per year of citizen life (life clock)") ?? 1,
    citizenLifeYearsPerGameMonth: paramMap.get("Years of citizen life per game month") ?? 1,
    serverMicroTickRealSeconds: paramMap.get("Server micro-tick") ?? 1,
    gameSecondsPerMicroTick: paramMap.get("Game time per micro-tick") ?? 30,
    seasonLengthDays: 30,
    noticeWindowMinGameDays: 3,
    noticeWindowMaxGameDays: 6,
    aiGovernorAfkHours: 48,
  };

  const commodityUnits: CommodityUnitSpec[] = [];
  for (let i = 20; i < rows.length; i++) {
    const r = rows[i]!;
    const name = (r[1] ?? "").trim();
    const tier = (r[2] ?? "").trim() as CommodityTier;
    if (!name) break;
    commodityUnits.push({
      name,
      tier,
      accountingUnit: (r[3] ?? "").trim(),
      massTonsPerUnit: parseNum(r[4]),
      cargoClass: (r[5] ?? "").trim(),
      outputPerGameHourLv1: parseNum(r[6]),
      outputPerGameMonthLv1: parseNum(r[7]),
    });
  }

  const infraMap = new Map<string, number>();
  for (let i = 46; i < rows.length; i++) {
    const r = rows[i]!;
    const key = (r[1] ?? "").trim();
    if (key && key !== "Item") {
      infraMap.set(key, parseNum(r[2]));
    }
  }

  const infrastructure: InfrastructureDefaults = {
    localStreet2LaneCostPerKm: money(
      infraMap.get("2-lane local street (includes under-road utility collector)") ?? 180_000
    ),
    heavyRailCostPerKm: money(infraMap.get("Heavy rail track") ?? 180_000),
    trunkPipelineCostPerKm: money(infraMap.get("Trunk gas or oil pipeline") ?? 180_000),
    compressorStationCost: money(infraMap.get("Compressor station") ?? 600_000),
    pipelineCapacityStandardPerHour:
      infraMap.get("Trunk pipeline capacity, standard (60 bar)") ?? 1_000,
    pipelineCapacityBoostedPerHour:
      infraMap.get("Trunk pipeline capacity, boosted (110 bar)") ?? 1_600,
    hvPowerLineCostPerKm: money(infraMap.get("High-voltage power line") ?? 120_000),
    substationCost: money(infraMap.get("Substation") ?? 350_000),
    hvPowerLineCapacityMw: infraMap.get("High-voltage line capacity") ?? 500,
  };

  return { timeBase, commodityUnits, infrastructure };
}

export interface DualCalendarSnapshot {
  readonly totalGameSeconds: number;
  readonly economicYear: number;
  readonly economicMonth: number; // 1-based month of season (1..30)
  readonly economicDayOfMonth: number; // 1..30
  readonly economicHourOfDay: number; // 0..23
  readonly economicMinuteOfHour: number; // 0..59
  readonly citizenLifeYearsElapsed: number;
}

/** Converts cumulative game seconds since world start into Dual Calendar readings (GDD §1.4). */
export function computeDualCalendar(
  totalGameSeconds: number,
  timeBase: TimeBaseConfig
): DualCalendarSnapshot {
  const secPerHour = 3600;
  const totalHours = Math.floor(totalGameSeconds / secPerHour);
  const economicMinuteOfHour = Math.floor((totalGameSeconds % secPerHour) / 60);
  const hoursPerDay = timeBase.gameHoursPerGameDay;
  const totalDays = Math.floor(totalHours / hoursPerDay);
  const economicHourOfDay = totalHours % hoursPerDay;
  const daysPerMonth = timeBase.gameDaysPerGameMonth;
  const monthZeroIdx = Math.floor(totalDays / daysPerMonth);
  const economicDayOfMonth = (totalDays % daysPerMonth) + 1;
  const economicMonth = monthZeroIdx + 1;
  const economicYear = Math.floor(monthZeroIdx / timeBase.gameMonthsPerGameYear) + 1;
  const citizenLifeYearsElapsed =
    (totalGameSeconds / (secPerHour * timeBase.gameHoursPerGameMonth)) *
    timeBase.citizenLifeYearsPerGameMonth;

  return {
    totalGameSeconds,
    economicYear,
    economicMonth,
    economicDayOfMonth,
    economicHourOfDay,
    economicMinuteOfHour,
    citizenLifeYearsElapsed,
  };
}
