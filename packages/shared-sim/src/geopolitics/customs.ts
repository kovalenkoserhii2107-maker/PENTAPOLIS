/**
 * Border Customs Posts (КПП): Visa Regimes, Cargo Lanes, Embargo, Smuggling & Notice Window
 * (Sprint 7, GDD §5.3, §1.4; sheet 19 `Customs & Gas Transit`).
 *
 * A border post (LOG-07) straddles the border of two neighbouring sectors and links their road,
 * pipeline and power networks. Each mayor runs their own side: visa regime, import/export duty per
 * cargo lane, embargoes and the inspection mode. Hostile moves — duty above 50%, a new embargo or
 * closing the border — only take effect after the notice window (3–6 game days), so the neighbour
 * can reroute or draw on reserves. Prohibitive duties push part of the flow into smuggling, which
 * pays no duty (GDD §5.3: 3%–41%).
 */
import { parseCsv, parseNum } from "../csv.ts";
import { RAW_SHEETS } from "../catalogs/rawSheets.generated.ts";
import { computeSmugglingRate } from "../economy/RegionalMoneyEngine.ts";
import type { BorderSidePolicyDto, CargoLaneId, VisaRegimeId } from "../protocol.ts";

export interface VisaRegimeSpec {
  readonly id: VisaRegimeId;
  readonly nameRu: string;
  readonly entryFeeUnits: number;
  readonly monthlyCrossers: number;
  readonly specialistsInflow: number;
  readonly tourismIndex: number;
  readonly queueMinutes: number;
  readonly smugglingRate: number;
}

export interface CargoLaneSpec {
  readonly id: CargoLaneId;
  readonly nameRu: string;
  readonly importDuty: number;
  readonly exportDuty: number;
  readonly exciseRate: number;
  readonly smugglingRate: number;
  readonly queueMinutes: number;
}

export interface GasRouteSpec {
  readonly id: "domestic" | "transit1" | "transit2" | "lng";
  readonly capacityKm3PerHour: number;
  readonly transitFeePerKm3Units: number;
  readonly offtakeShare: number;
  readonly deliveredCostPerKm3Units: number;
  readonly factoryBonus: number;
}

export interface GasIndustrySpec {
  readonly match: RegExp;
  readonly outputBoost: number;
  readonly emissionsReduction: number;
}

export interface CustomsTables {
  readonly visas: ReadonlyMap<VisaRegimeId, VisaRegimeSpec>;
  readonly lanes: ReadonlyMap<CargoLaneId, CargoLaneSpec>;
  readonly gasRoutes: ReadonlyMap<GasRouteSpec["id"], GasRouteSpec>;
  readonly gasIndustries: readonly GasIndustrySpec[];
}

export const VISA_NAMES_RU: Readonly<Record<VisaRegimeId, string>> = {
  visa_free: "Безвиз",
  paid_visa: "Платная виза",
  skilled_quota: "Квота для специалистов",
  closed: "Граница закрыта",
};

export const LANE_NAMES_RU: Readonly<Record<CargoLaneId, string>> = {
  raw: "Сырьё (руда, уголь, камень, лес)",
  hydrocarbons: "Углеводороды (газ, нефть, топливо)",
  agri: "Продовольствие (зерно, продукты)",
  manufactured: "Промтовары (сталь, цемент, техника)",
  luxury: "Акцизные и люкс",
};

export const CARGO_LANES: readonly CargoLaneId[] = ["raw", "hydrocarbons", "agri", "manufactured", "luxury"];

const VISA_ROWS: ReadonlyArray<readonly [RegExp, VisaRegimeId]> = [
  [/^visa-free/i, "visa_free"],
  [/^paid tourist/i, "paid_visa"],
  [/^skilled-only/i, "skilled_quota"],
  [/^closed border/i, "closed"],
];
const LANE_ROWS: ReadonlyArray<readonly [RegExp, CargoLaneId]> = [
  [/^raw materials/i, "raw"],
  [/^hydrocarbons/i, "hydrocarbons"],
  [/^agricultural/i, "agri"],
  [/^manufactured/i, "manufactured"],
  [/^high-excise/i, "luxury"],
];
const GAS_ROWS: ReadonlyArray<readonly [RegExp, GasRouteSpec["id"]]> = [
  [/^direct domestic/i, "domestic"],
  [/^transit via 1/i, "transit1"],
  [/^transit via 2/i, "transit2"],
  [/^maritime/i, "lng"],
];
const INDUSTRY_ROWS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^blast furnace/i, /steel/i],
  [/^rotary kiln/i, /cement/i],
  [/^petrochemical/i, /fuel|plastics|fertilizers|polymers/i],
];

export function parseCustomsSheet(csvText: string): CustomsTables {
  const rows = parseCsv(csvText);
  const visas = new Map<VisaRegimeId, VisaRegimeSpec>();
  const lanes = new Map<CargoLaneId, CargoLaneSpec>();
  const gasRoutes = new Map<GasRouteSpec["id"], GasRouteSpec>();
  const gasIndustries: GasIndustrySpec[] = [];
  for (const r of rows) {
    const name = (r[1] ?? "").trim();
    const visa = VISA_ROWS.find(([re]) => re.test(name));
    if (visa && !visas.has(visa[1])) {
      visas.set(visa[1], {
        id: visa[1],
        nameRu: VISA_NAMES_RU[visa[1]],
        entryFeeUnits: parseNum(r[2]),
        monthlyCrossers: parseNum(r[3]),
        specialistsInflow: parseNum(r[4]),
        tourismIndex: parseNum(r[5]),
        queueMinutes: parseNum(r[6]),
        smugglingRate: parseNum(r[8]),
      });
      continue;
    }
    const lane = LANE_ROWS.find(([re]) => re.test(name));
    if (lane && !lanes.has(lane[1])) {
      lanes.set(lane[1], {
        id: lane[1],
        nameRu: LANE_NAMES_RU[lane[1]],
        importDuty: parseNum(r[2]),
        exportDuty: parseNum(r[3]),
        exciseRate: parseNum(r[4]),
        smugglingRate: parseNum(r[8]),
        queueMinutes: parseNum(/(\d+)\s*min/.exec(r[9] ?? "")?.[1]),
      });
      continue;
    }
    const gas = GAS_ROWS.find(([re]) => re.test(name));
    if (gas && !gasRoutes.has(gas[1])) {
      gasRoutes.set(gas[1], {
        id: gas[1],
        capacityKm3PerHour: parseNum(r[3]),
        transitFeePerKm3Units: parseNum(r[4]),
        offtakeShare: parseNum(r[5]),
        deliveredCostPerKm3Units: parseNum(r[7]),
        factoryBonus: parseNum(r[9]),
      });
      continue;
    }
    const ind = INDUSTRY_ROWS.find(([re]) => re.test(name));
    if (ind) {
      gasIndustries.push({ match: ind[1], outputBoost: parseNum(r[5]), emissionsReduction: parseNum(r[6]) });
    }
  }
  return { visas, lanes, gasRoutes, gasIndustries };
}

let cachedCustoms: CustomsTables | null = null;

export function getCustomsTables(): CustomsTables {
  if (!cachedCustoms) {
    cachedCustoms = parseCustomsSheet(RAW_SHEETS["Customs & Gas Transit"] ?? "");
    if (cachedCustoms.visas.size !== 4 || cachedCustoms.lanes.size !== 5 || cachedCustoms.gasRoutes.size !== 4) {
      throw new Error("Sheet 19 `Customs & Gas Transit` is incomplete");
    }
  }
  return cachedCustoms;
}

/** Cargo lane of a commodity (sheet 19 Part B categories). */
export function cargoLaneOf(commodity: string): CargoLaneId {
  if (/luxury/i.test(commodity)) return "luxury";
  if (/crude|natural gas|fuel/i.test(commodity)) return "hydrocarbons";
  if (/grain|flour|food/i.test(commodity)) return "agri";
  if (/ore|coal|limestone|quartz|timber/i.test(commodity)) return "raw";
  return "manufactured";
}

/** Sheet defaults for a newly built post: paid visa, sheet duties, 3% transit duty, no embargo, green corridor, open gas valve. */
export function defaultBorderPolicy(sectorId: BorderSidePolicyDto["sectorId"]): BorderSidePolicyDto {
  const t = getCustomsTables();
  const importDuty = {} as Record<CargoLaneId, number>;
  const exportDuty = {} as Record<CargoLaneId, number>;
  const transitDuty = {} as Record<CargoLaneId, number>;
  for (const lane of CARGO_LANES) {
    importDuty[lane] = t.lanes.get(lane)!.importDuty;
    exportDuty[lane] = t.lanes.get(lane)!.exportDuty;
    transitDuty[lane] = 0.03;
  }
  return {
    sectorId,
    visaRegime: "paid_visa",
    importDuty,
    exportDuty,
    transitDuty,
    embargo: [],
    inspection: "green",
    sanitaryQuarantine: false,
    gasValveOpen: true,
  };
}

/** Smuggled share of a lane's flow into a side (GDD §5.3); strict inspection halves it. */
export function laneSmugglingRate(side: BorderSidePolicyDto, lane: CargoLaneId): number {
  const base = computeSmugglingRate(side.importDuty[lane] + getCustomsTables().lanes.get(lane)!.exciseRate, side.embargo.includes(lane));
  return side.inspection === "strict" ? base * 0.5 : base;
}

/** Whether cargo of a lane may cross from `exporter` into `importer` (embargo on either side blocks it). */
export function laneOpen(exporter: BorderSidePolicyDto, importer: BorderSidePolicyDto, lane: CargoLaneId): boolean {
  return (
    exporter.visaRegime !== "closed" &&
    importer.visaRegime !== "closed" &&
    !exporter.embargo.includes(lane) &&
    !importer.embargo.includes(lane)
  );
}

export const HOSTILE_DUTY_THRESHOLD = 0.5;
export const NOTICE_DAYS_DUTY = 3;
export const NOTICE_DAYS_EMBARGO = 6;

/**
 * Notice window (GDD §1.4): returns the game days a policy change must wait, or 0 if it applies at once.
 */
export function noticeDaysFor(current: BorderSidePolicyDto, next: BorderSidePolicyDto): number {
  const closes = next.visaRegime === "closed" && current.visaRegime !== "closed";
  const newEmbargo = next.embargo.some((l) => !current.embargo.includes(l));
  if (closes || newEmbargo) return NOTICE_DAYS_EMBARGO;
  const hostileDuty = CARGO_LANES.some(
    (l) => next.importDuty[l] > HOSTILE_DUTY_THRESHOLD && next.importDuty[l] > current.importDuty[l]
  );
  const hostileTransit = CARGO_LANES.some(
    (l) =>
      (next.transitDuty?.[l] ?? 0) > HOSTILE_DUTY_THRESHOLD &&
      (next.transitDuty?.[l] ?? 0) > (current.transitDuty?.[l] ?? 0)
  );
  return hostileDuty || hostileTransit ? NOTICE_DAYS_DUTY : 0;
}

/** Trucks per game hour a post clears at lanes level 1..5 (strict inspection halves throughput). */
export function postTruckCapacityPerHour(level: number, inspection: BorderSidePolicyDto["inspection"]): number {
  return 12 * Math.max(1, level) * (inspection === "strict" ? 0.5 : 1);
}

/** Queue minutes: lane clearance from the sheet, plus overflow when trucks exceed capacity. */
export function borderQueueMinutes(params: {
  readonly trucksPerHour: number;
  readonly capacityPerHour: number;
  readonly baseQueueMinutes: number;
  readonly inspection: BorderSidePolicyDto["inspection"];
}): number {
  const base = params.baseQueueMinutes * (params.inspection === "strict" ? 2 : 1);
  const load = params.capacityPerHour > 0 ? params.trucksPerHour / params.capacityPerHour : 0;
  return Math.round(base + Math.max(0, load - 0.8) * 300);
}

/** A queue this long becomes the KPP blockade emergency (GDD §6.6 #10). */
export const BLOCKADE_QUEUE_MINUTES = 120;
