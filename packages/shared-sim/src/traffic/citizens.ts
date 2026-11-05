/**
 * Two-Layer Agent Inspector: Vehicle Card -> Citizen Dossier (Sprint 5, GDD §7, sheet 24 Table 2).
 *
 * The dossier of the driver behind any visible vehicle is rebuilt on demand from the live economy
 * of their region: their household class budget (wage, rent, food, utilities, transport, goods,
 * leisure, insurance, PIT, property tax — `RegionalMoneyEngine` class state × CPI), personal
 * variation seeded by the citizen ID, and the real conditions of their commute (road health on
 * the route, bus/metro coverage) and city (VAT, inflation, blackouts, decrees). Every money line
 * is an exact `bigint`; totals are sums of the lines.
 */
import type { HouseholdClassState } from "../economy/RegionalMoneyEngine.ts";
import { money, mulRate, type Money } from "../money/money.ts";
import type {
  CitizenDossierDto,
  DistrictDto,
  CitizenThoughtDto,
  DossierLineDto,
  VehicleInspectorDto,
} from "../protocol.ts";
import type { MasterCatalogs } from "../catalogs/index.ts";
import { seededRandom, type CitizenContext, type VehicleAgentRecord } from "./trafficModel.ts";

export interface DossierRegionInput {
  readonly classes: readonly HouseholdClassState[];
  readonly cpi: number;
  readonly happinessIndex: number;
  readonly annualInflation: number;
  readonly keyRate: number;
  readonly vatRate: number;
  readonly exportDutyRate: number;
  readonly fxRatePerWcu: number;
  readonly activeDecreeIds: readonly string[];
  readonly powerDeficit: boolean;
  readonly currencySymbol: string;
  /** The citizen's home district (Sprint 6): crime, ecology, services, prestige. */
  readonly homeDistrict?: DistrictDto;
}

const CLASS_NAMES_RU: Readonly<Record<CitizenContext["classId"], string>> = {
  workers: "Рабочий класс",
  engineers: "Инженеры и специалисты",
  elite: "Предприниматели и элита",
  retirees: "Пенсионеры",
};

const FIRST_NAMES = [
  "Олександр", "Тарас", "Андрей", "Марко", "Богдан", "Дмитрий", "Сергей", "Иван", "Остап", "Назар",
  "Олена", "Ирина", "Наталья", "Оксана", "Марина", "Юлия", "Анна", "Катерина", "Софья", "Дарина",
];
const SURNAMES = [
  "Коваленко", "Бондаренко", "Шевченко", "Ткаченко", "Мельник", "Кравчук", "Олейник", "Савчук",
  "Лысенко", "Марченко", "Руденко", "Гончар", "Полищук", "Петренко", "Ковальчук", "Бойко",
  "Кушнир", "Литвин", "Мороз", "Сидоренко",
];

const AGE_RANGE: Readonly<Record<CitizenContext["classId"], readonly [number, number]>> = {
  workers: [19, 63],
  engineers: [24, 63],
  elite: [30, 70],
  retirees: [65, 88],
};

function sumMoney(lines: readonly { amount: Money }[]): Money {
  return lines.reduce((s, l) => s + l.amount, 0n);
}

function toDto(lines: ReadonlyArray<{ label: string; amount: Money }>): DossierLineDto[] {
  return lines.map((l) => ({ label: l.label, amountMinor: l.amount.toString() }));
}

export function buildCitizenDossier(ctx: CitizenContext, region: DossierRegionInput): CitizenDossierDto {
  const rnd = seededRandom(`dossier:${ctx.citizenId}`);
  const cls = region.classes.find((c) => c.id === ctx.classId) ?? region.classes[0]!;
  const personal = 0.88 + rnd() * 0.24;
  const p = region.cpi * personal;
  const lineOf = (label: string, units: number) => ({ label, amount: money(Math.max(0, units * p)) });

  const fullName = `${FIRST_NAMES[Math.floor(rnd() * FIRST_NAMES.length)]} ${SURNAMES[Math.floor(rnd() * SURNAMES.length)]}`;
  const [aMin, aMax] = AGE_RANGE[ctx.classId];
  const age = aMin + Math.floor(rnd() * (aMax - aMin + 1));
  const married = rnd() < 0.6;
  const kids = married ? Math.floor(rnd() * 3.2) : rnd() < 0.15 ? 1 : 0;
  const familyRu = `${married ? "В браке" : "Не в браке"}${kids > 0 ? `, детей: ${kids}` : ", без детей"}`;

  // Savings reserve: the household's share of the class deposits stock
  const hh = Math.max(1, Math.round(cls.households));
  const reserve = mulRate(cls.deposits / BigInt(hh), personal);
  const depositRate = Math.max(0, region.keyRate - 0.03);

  const grossLabel = ctx.classId === "retirees" ? "Пенсия" : `Зарплата (${ctx.workRoleRu})`;
  const income = [
    ctx.classId === "retirees"
      ? lineOf(grossLabel, cls.pensionUnits)
      : lineOf(grossLabel, cls.wageUnits),
    { label: `Проценты по вкладу (${(depositRate * 100).toFixed(1)}% год.)`, amount: mulRate(reserve, depositRate / 12) },
  ];
  const gross = income[0]!.amount;

  // Commute cost reacts to the road condition: potholes burn fuel and break suspensions
  const roadPenalty =
    ctx.commuteMode === "car" ? (ctx.commuteMinHealth < 40 ? 1.45 : ctx.commuteMinHealth < 75 ? 1.2 : 1) : 1;
  const fare =
    ctx.commuteMode === "bus" || (ctx.commuteMode !== "car" && (ctx.busCovered || ctx.metroCovered))
      ? region.activeDecreeIds.includes("FREE_TRANSIT")
        ? 0.15
        : 0.6
      : 1;
  const transportLabel =
    ctx.commuteMode === "car" ? "Топливо, ремонт и парковка" : ctx.commuteMode === "driver" ? "Дорога до депо" : "Проездной";

  const expenses = [
    { label: `НДФЛ (${Math.round(cls.pitRate * 100)}%)`, amount: mulRate(gross, cls.pitRate) },
    lineOf("Налог на недвижимость", cls.propertyTaxUnits),
    lineOf("Аренда / ипотека", cls.housingUnits),
    lineOf("Продукты", cls.foodUnits),
    lineOf(region.powerDeficit ? "Коммунальные услуги (с генератором)" : "Газ, свет, вода", cls.utilitiesUnits * (region.powerDeficit ? 1.25 : 1)),
    lineOf(transportLabel, cls.transportUnits * roadPenalty * fare),
    lineOf("Товары и досуг", cls.goodsUnits + cls.leisureUnits),
    lineOf("Страхование", cls.insuranceUnits),
  ];

  const totalIncome = sumMoney(income);
  const totalExpenses = sumMoney(expenses);
  const net = totalIncome - totalExpenses;
  const savingsRate = totalIncome > 0n ? Number((net * 10_000n) / totalIncome) / 10_000 : 0;

  // Thoughts from real city conditions (GDD §7, sheet 24: "tells you exactly which roads to repair")
  const thoughts: CitizenThoughtDto[] = [];
  if (ctx.commuteMode === "car" || ctx.commuteMode === "driver") {
    if (ctx.commuteMinHealth < 40) thoughts.push({ text: "Разбитая дорога на моём маршруте — боюсь за подвеску", delta: -12 });
    else if (ctx.commuteMinHealth < 75) thoughts.push({ text: "Теряю время в пробках из-за ям на дороге", delta: -8 });
    else thoughts.push({ text: "Дороги в порядке, доезжаю без задержек", delta: 4 });
  }
  if (ctx.metroCovered) thoughts.push({ text: "Метро рядом с домом — квартира подорожала", delta: 10 });
  else if (ctx.busCovered) thoughts.push({ text: "Удобный автобус рядом с домом", delta: 6 });
  else if (ctx.classId === "workers") thoughts.push({ text: "Без машины до работы не добраться — нет автобуса", delta: -5 });
  if (region.vatRate >= 0.15) thoughts.push({ text: `НДС ${Math.round(region.vatRate * 100)}% — всё дорожает`, delta: -10 });
  else if (region.vatRate <= 0.07) thoughts.push({ text: "Низкий НДС, цены в магазинах радуют", delta: 5 });
  if (region.annualInflation > 0.08) thoughts.push({ text: "Цены растут быстрее зарплаты", delta: -12 });
  if (region.powerDeficit) thoughts.push({ text: "Вечерние отключения света", delta: -10 });
  if (region.activeDecreeIds.includes("GAS_SUBSIDY")) thoughts.push({ text: "Доволен газовым отоплением", delta: 10 });
  if (region.activeDecreeIds.includes("FREE_TRANSIT") && (ctx.busCovered || ctx.metroCovered)) {
    thoughts.push({ text: "Бесплатный проезд экономит деньги", delta: 6 });
  }
  const district = region.homeDistrict;
  if (district) {
    if (district.crimeRate > 0.15) thoughts.push({ text: "Страшно выходить вечером — полиции не видно", delta: -8 });
    if (district.ecology < 0.4) thoughts.push({ text: "Дышать нечем из-за заводского дыма", delta: -10 });
    if (district.coverage.health < 0.3) thoughts.push({ text: "Далеко до поликлиники", delta: -6 });
    if (kids > 0 && district.coverage.kindergarten < 0.3) thoughts.push({ text: "Нет мест в детсаду — жена сидит дома", delta: -7 });
    if (district.coverage.park > 0.5) thoughts.push({ text: "Парк рядом с домом", delta: 5 });
    if (district.tier >= 4) thoughts.push({ text: `Живу в престижном районе (${district.tierNameRu})`, delta: 6 });
  }
  if (net < 0n) thoughts.push({ text: "Не хватает до зарплаты, проедаю сбережения", delta: -15 });
  else if (savingsRate > 0.1) thoughts.push({ text: "Удаётся откладывать каждый месяц", delta: 6 });
  thoughts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const topThoughts = thoughts.slice(0, 4);

  const mood = topThoughts.reduce((s, t) => s + t.delta, 0) * 0.5 + (rnd() - 0.5) * 8;
  const satisfaction = Math.max(0, Math.min(100, Math.round(region.happinessIndex + mood)));

  return {
    id: ctx.citizenId,
    fullName,
    age,
    classId: ctx.classId,
    classNameRu: CLASS_NAMES_RU[ctx.classId],
    statusRu: ctx.classId === "retirees" ? "На пенсии" : "Работает",
    familyRu,
    sectorId: ctx.sectorId,
    home: { label: ctx.homeLabel, tileX: Math.round(ctx.homeX), tileY: Math.round(ctx.homeY) },
    workplace: {
      label: ctx.workLabel,
      roleRu: ctx.workRoleRu,
      tileX: Math.round(ctx.workX),
      tileY: Math.round(ctx.workY),
    },
    commuteKm: Number((ctx.commuteTiles * 0.01).toFixed(2)),
    commuteModeRu:
      ctx.commuteMode === "car"
        ? "Личный автомобиль"
        : ctx.commuteMode === "driver"
          ? "За рулём служебного транспорта"
          : ctx.commuteMode === "bus"
            ? "Автобус"
            : "Метро",
    currencySymbol: region.currencySymbol,
    income: toDto(income),
    expenses: toDto(expenses),
    totalIncomeMinor: totalIncome.toString(),
    totalExpensesMinor: totalExpenses.toString(),
    netSavingsMinor: net.toString(),
    savingsRate: Number(savingsRate.toFixed(4)),
    cumulativeReserveMinor: reserve.toString(),
    satisfaction,
    thoughts: topThoughts,
    vehicleId: ctx.vehicleId,
  };
}

export function buildVehicleInspector(
  rec: VehicleAgentRecord,
  catalogs: MasterCatalogs,
  region: Pick<DossierRegionInput, "fxRatePerWcu" | "exportDutyRate" | "currencySymbol">
): VehicleInspectorDto {
  const vt = catalogs.vehiclesById.get(rec.dto.vehicleTypeId);
  const rnd = seededRandom(`plate:${rec.dto.id}`);
  const letters = "АВЕКМНОРСТХ";
  const plate = `S${rec.dto.sectorId} ${letters[Math.floor(rnd() * letters.length)]}${letters[Math.floor(rnd() * letters.length)]} ${1000 + Math.floor(rnd() * 9000)}`;

  let cargo: VehicleInspectorDto["cargo"] = null;
  if (rec.cargo) {
    const valueLocal = mulRate(rec.cargo.valueWcu, region.fxRatePerWcu);
    const duty = rec.cargo.border
      ? mulRate(valueLocal, rec.cargo.border.importDuty)
      : rec.cargo.exportViaGateway
        ? mulRate(valueLocal, region.exportDutyRate)
        : 0n;
    cargo = {
      commodity: rec.cargo.commodity,
      payload: rec.cargo.payload,
      capacity: rec.cargo.capacity,
      unit: rec.cargo.unit,
      valueMinor: valueLocal.toString(),
      dutyPaidMinor: duty.toString(),
      dutyLabel: rec.cargo.border
        ? `Ввозная пошлина ${(rec.cargo.border.importDuty * 100).toFixed(1)}% на КПП #${rec.cargo.border.postId} (Сектор ${rec.cargo.border.toSector})`
        : rec.cargo.exportViaGateway
          ? `Вывозная пошлина ${(region.exportDutyRate * 100).toFixed(1)}% на внешнем шлюзе`
          : "Внутренняя поставка — без пошлины",
    };
  }

  return {
    id: rec.dto.id,
    vehicleTypeId: rec.dto.vehicleTypeId,
    typeNameRu: vt?.nameRu ?? rec.dto.vehicleTypeId,
    role: rec.dto.role,
    sectorId: rec.dto.sectorId,
    plate,
    liveryColorHex: rec.dto.colorHex,
    ownerLabel: rec.ownerLabel,
    originLabel: rec.originLabel,
    waypointLabel: rec.waypointLabel,
    destinationLabel: rec.destinationLabel,
    cargo,
    passengers: rec.passengers,
    currencySymbol: region.currencySymbol,
    speedKmh: rec.speedKmh,
    speedLimitKmh: rec.speedLimitKmh,
    avgRoadHealth: rec.avgRoadHealth,
    roadWearFactor: rec.roadWearFactor,
    roadWearPerPassPercent: rec.roadWearPerPassPercent,
    driverCitizenId: rec.driverCitizenId,
    shiftHoursRemaining: rec.shiftHoursRemaining,
  };
}
