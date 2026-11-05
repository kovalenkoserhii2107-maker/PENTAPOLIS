/**
 * Sectors, Resource Balance, Mayor Levers, 8 City Decrees, 12 Live Emergencies,
 * Quality 1★–5★, Growth/Happiness Curve, and 1,000-pt Hegemony Index
 * (Sheets 09, 10, 12, 18, 20, 21 — GDD Chapters 2, 3, 4, 6, 9).
 */
import { parseCsv, parseNum } from "../csv.ts";
import type { SectorId } from "./visuals.ts";

export interface SectorResourceStream {
  readonly sectorId: SectorId;
  readonly streamName: string;
  readonly role: "Profile" | "Secondary" | "Scarce";
  readonly resourceGroup: string;
  readonly maxExtractionPerHour: number;
  readonly unit: string;
  readonly tier4PeakDemandPerHour: number;
  readonly domesticCoverageRatio: number;
  readonly netTradeBalancePerHour: number;
}

export interface SectorProfileSpec {
  readonly sectorId: SectorId;
  readonly code: `S${SectorId}`;
  readonly nameEn: string;
  readonly nameRu: string;
  readonly positionDesc: string;
  readonly profileSummaryRu: string;
  readonly starterExternalGateway: "overland_highway" | "underground_tunnel";
  readonly gatewayLabelRu: string;
  readonly neighborSectors: readonly SectorId[];
  readonly maxPortDraftMeters: number;
  readonly hasHydroPotential: boolean;
  readonly specializationPerk: string;
  readonly resourceStreams: readonly SectorResourceStream[];
}

export interface MayorLeverSpec {
  readonly id: string;
  readonly section: "taxes" | "social" | "business" | "central_bank";
  readonly name: string;
  readonly defaultValue: number;
  readonly minValue: number;
  readonly maxValue: number;
  readonly requiresNoticeWindowAbove?: number;
  readonly effectNote: string;
}

export interface CityDecreeSpec {
  readonly id: string;
  readonly index: number;
  readonly nameEn: string;
  readonly nameRu: string;
  readonly effectSummary: string;
  readonly sideEffectSummary: string;
}

export type EmergencyId =
  | "FIRE"
  | "PIPE_BURST"
  | "ROAD_CRASH"
  | "LABOR_STRIKE"
  | "BANK_HEIST"
  | "COAL_SMOG"
  | "RIVER_POLLUTION"
  | "GARBAGE_COLLAPSE"
  | "PEAK_BLACKOUT"
  | "KPP_BLOCKADE"
  | "FROZEN_CONSTRUCTION"
  | "SEA_STORM";

export interface EmergencyTypeSpec {
  readonly id: EmergencyId;
  readonly index: number;
  readonly nameRu: string;
  readonly nameEn: string;
  readonly responderBuildingId: string | null;
  readonly impactSummaryRu: string;
}

export const CANONICAL_EMERGENCIES: readonly EmergencyTypeSpec[] = [
  { id: "FIRE", index: 1, nameRu: "Промышленный/бытовой пожар", nameEn: "Building Fire", responderBuildingId: "SAF-02", impactSummaryRu: "Выезд пожарных; без тушения завод деградирует до Ур.1" },
  { id: "PIPE_BURST", index: 2, nameRu: "Прорыв теплотрассы/водопровода", nameEn: "Utility Pipe Burst", responderBuildingId: "UTL-01", impactSummaryRu: "Гейзер на дороге, скорость движения -50%, выезд аварийки" },
  { id: "ROAD_CRASH", index: 3, nameRu: "Крупное ДТП на разбитой дороге", nameEn: "Major Road Crash", responderBuildingId: "SAF-01", impactSummaryRu: "Возникает при прочности полотна <40%; полиция, скорая и эвакуатор" },
  { id: "LABOR_STRIKE", index: 4, nameRu: "Забастовка и пикет у ворот завода", nameEn: "Factory Strike", responderBuildingId: "SAF-01", impactSummaryRu: "Выработка завода -70% при падении реальных зарплат" },
  { id: "BANK_HEIST", index: 5, nameRu: "Ограбление банка и полицейская погоня", nameEn: "Bank Heist", responderBuildingId: "SAF-01", impactSummaryRu: "Всплеск преступности и рост страхового тарифа при слабой полиции" },
  { id: "COAL_SMOG", index: 6, nameRu: "Угольный смог", nameEn: "Coal Valley Smog", responderBuildingId: "HLT-02", impactSummaryRu: "Здоровье горожан -15%, очередь скорых у больниц" },
  { id: "RIVER_POLLUTION", index: 7, nameRu: "Химическое загрязнение реки", nameEn: "River Sewage Spill", responderBuildingId: "UTL-02", impactSummaryRu: "Закрытие пляжей и падение здоровья при нехватке очистных" },
  { id: "GARBAGE_COLLAPSE", index: 8, nameRu: "Мусорный коллапс на тротуарах", nameEn: "Garbage Overflow", responderBuildingId: "UTL-03", impactSummaryRu: "Падение Land Value на -30% при дефиците полигонов/переработки" },
  { id: "PEAK_BLACKOUT", index: 9, nameRu: "Веерное отключение света в пик", nameEn: "Evening Peak Blackout", responderBuildingId: "ENG-02", impactSummaryRu: "Срез экспорта -> -20% заводов -> отключение кварталов" },
  { id: "KPP_BLOCKADE", index: 10, nameRu: "Многокилометровая блокада фур на КПП", nameEn: "Border KPP Gridlock", responderBuildingId: "LOG-07", impactSummaryRu: "Очередь на границе при жёстком досмотре или нехватке полос" },
  { id: "FROZEN_CONSTRUCTION", index: 11, nameRu: "Замерший кран долгостроя", nameEn: "Frozen Investment Site", responderBuildingId: "CIV-01", impactSummaryRu: "Частный рынок не выкупил 90% акций завода — доступен выкуп Мэрией" },
  { id: "SEA_STORM", index: 12, nameRu: "Морской шторм на рейде", nameEn: "Harbor Sea Storm", responderBuildingId: "LOG-04", impactSummaryRu: "Скорость погрузки морских портов временно снижена на -40%" },
] as const;

export const CANONICAL_DECREES: readonly CityDecreeSpec[] = [
  { id: "FREE_TRANSIT", index: 1, nameEn: "Free Municipal Transport", nameRu: "Бесплатный муниципальный транспорт", effectSummary: "-30% личных авто на дорогах, +5 к счастью", sideEffectSummary: "Казна теряет выручку от билетов" },
  { id: "WASTE_SORTING", index: 2, nameEn: "Mandatory Waste Sorting", nameRu: "Обязательная сортировка отходов", effectSummary: "+20% вторсырья на переработке", sideEffectSummary: "Небольшой расход бюджета на инспекцию" },
  { id: "GAS_SUBSIDY", index: 3, nameEn: "Home Gasification Subsidy", nameRu: "Субсидия на газификацию жилья", effectSummary: "+25% чистоты воздуха, рост Land Value", sideEffectSummary: "Рост потребления бытового газа на +15%" },
  { id: "NIGHT_CURFEW", index: 4, nameEn: "Night Curfew & Casino Limits", nameRu: "Ночной комендантский час и ограничение казино", effectSummary: "-25% преступности и игромании", sideEffectSummary: "-5% выручки ночного досуга и акцизов" },
  { id: "FIRE_CODE", index: 5, nameEn: "Strict Fire Safety Standard", nameRu: "Стандарт пожаробезопасности", effectSummary: "-40% пожаров, -20% цена страховки", sideEffectSummary: "+5% к стоимости строительства и содержания" },
  { id: "TECHNOPARK_HOLIDAY", index: 6, nameEn: "Tax Holidays for Technoparks", nameRu: "Налоговые каникулы для технопарков", effectSummary: "Рост качества товаров до 4★–5★, приток инженеров", sideEffectSummary: "Снижение сбора налога на прибыль в ИТ-зонах" },
  { id: "YOUNG_FAMILY", index: 7, nameEn: "Young Family Programme", nameRu: "Программа «Молодая семья»", effectSummary: "+30% рождаемости в семьях", sideEffectSummary: "Дополнительная нагрузка на бюджет и детсады" },
  { id: "TRUCK_WEIGHT_CONTROL", index: 8, nameEn: "Truck Axle-Weight Control", nameRu: "Весовой контроль фур", effectSummary: "-25% физического износа дорог", sideEffectSummary: "-10% скорости грузовиков на трассах" },
] as const;

/** Ring topology 1 <-> 2 <-> 5 <-> 4 <-> 3 <-> 1 (GDD §2.2 & map scheme). */
const SECTOR_METADATA: Readonly<
  Record<
    SectorId,
    {
      nameRu: string;
      profileSummaryRu: string;
      gateway: "overland_highway" | "underground_tunnel";
      gatewayLabelRu: string;
      neighbors: readonly SectorId[];
      draftM: number;
      hydro: boolean;
    }
  >
> = {
  1: {
    nameRu: "Северный Бассейн",
    profileSummaryRu: "Железная руда, коксующийся уголь и чёрная металлургия",
    gateway: "overland_highway",
    gatewayLabelRu: "Наземная магистраль №1 (северная граница, 2 полосы)",
    neighbors: [2, 3],
    draftM: 12,
    hydro: false,
  },
  2: {
    nameRu: "Нефтегазовый Шельф",
    profileSummaryRu: "Сырая нефть, природный газ и нефтехимия",
    gateway: "overland_highway",
    gatewayLabelRu: "Наземная магистраль №2 (северная граница, 2 полосы)",
    neighbors: [1, 5],
    draftM: 18,
    hydro: false,
  },
  3: {
    nameRu: "Центральная Долина",
    profileSummaryRu: "Зерновые культуры, лес, пиломатериалы и продовольствие",
    gateway: "underground_tunnel",
    gatewayLabelRu: "Подземный туннель №1 у Центрального ядра (2 полосы)",
    neighbors: [1, 4],
    draftM: 8,
    hydro: false,
  },
  4: {
    nameRu: "Южное Предгорье",
    profileSummaryRu: "Известняк, гранит, цемент, префабы и каскад ГЭС",
    gateway: "underground_tunnel",
    gatewayLabelRu: "Подземный туннель №2 у Центрального ядра (2 полосы)",
    neighbors: [3, 5],
    draftM: 10,
    hydro: true,
  },
  5: {
    nameRu: "Восточный Мыс",
    profileSummaryRu: "Кварцевый песок, микрочипы, автопром, ГЭС и глубоководный мегапорт",
    gateway: "underground_tunnel",
    gatewayLabelRu: "Подземный туннель №3 у Центрального ядра (2 полосы)",
    neighbors: [2, 4],
    draftM: 22,
    hydro: true,
  },
};

export function parsePlayerSectorsSheet(csvText: string): SectorProfileSpec[] {
  const rows = parseCsv(csvText);
  const perks = new Map<SectorId, { nameEn: string; pos: string; perk: string }>();

  for (let i = 4; i <= 9 && i < rows.length; i++) {
    const r = rows[i]!;
    const title = (r[1] ?? "").trim();
    const m = /^Sector\s+([1-5]):\s*(.+)$/i.exec(title);
    if (!m) continue;
    const id = parseInt(m[1]!, 10) as SectorId;
    perks.set(id, {
      nameEn: m[2]!.trim(),
      pos: (r[2] ?? "").trim(),
      perk: (r[8] ?? "").trim(),
    });
  }

  const streamsBySector = new Map<SectorId, SectorResourceStream[]>();
  for (let i = 14; i <= 40 && i < rows.length; i++) {
    const r = rows[i]!;
    const label = (r[1] ?? "").trim();
    const m = /^Sector\s+([1-5])\s*[—-]\s*(.+)$/i.exec(label);
    if (!m) continue;
    const sectorId = parseInt(m[1]!, 10) as SectorId;
    const roleRaw = (r[11] ?? "").trim();
    const role: "Profile" | "Secondary" | "Scarce" =
      roleRaw === "Profile" || roleRaw === "Secondary" ? roleRaw : "Scarce";
    const list = streamsBySector.get(sectorId) ?? [];
    list.push({
      sectorId,
      streamName: m[2]!.trim(),
      role,
      resourceGroup: (r[10] ?? "").trim(),
      maxExtractionPerHour: parseNum(r[3]),
      unit: (r[4] ?? "").trim(),
      tier4PeakDemandPerHour: parseNum(r[5]),
      domesticCoverageRatio: parseNum(r[6]),
      netTradeBalancePerHour: parseNum(r[7]),
    });
    streamsBySector.set(sectorId, list);
  }

  return ([1, 2, 3, 4, 5] as const).map((sectorId) => {
    const meta = SECTOR_METADATA[sectorId];
    const p = perks.get(sectorId);
    return {
      sectorId,
      code: `S${sectorId}`,
      nameEn: p?.nameEn ?? `Sector ${sectorId}`,
      nameRu: meta.nameRu,
      positionDesc: p?.pos ?? "",
      profileSummaryRu: meta.profileSummaryRu,
      starterExternalGateway: meta.gateway,
      gatewayLabelRu: meta.gatewayLabelRu,
      neighborSectors: meta.neighbors,
      maxPortDraftMeters: meta.draftM,
      hasHydroPotential: meta.hydro,
      specializationPerk: p?.perk ?? "",
      resourceStreams: streamsBySector.get(sectorId) ?? [],
    };
  });
}

export const DEFAULT_MAYOR_LEVERS: readonly MayorLeverSpec[] = [
  { id: "pit_workers", section: "taxes", name: "Подоходный налог: рабочие", defaultValue: 0.12, minValue: 0, maxValue: 0.40, effectNote: "Снижает свободный доход рабочих" },
  { id: "pit_engineers", section: "taxes", name: "Подоходный налог: инженеры", defaultValue: 0.18, minValue: 0, maxValue: 0.45, effectNote: "Выше соседей — отток специалистов" },
  { id: "pit_elite", section: "taxes", name: "Подоходный налог: элита", defaultValue: 0.24, minValue: 0, maxValue: 0.50, effectNote: "Влияет на приток капитала и элиты" },
  { id: "vat", section: "taxes", name: "НДС (VAT)", defaultValue: 0.10, minValue: 0, maxValue: 0.25, effectNote: "Главный налог казны; >15% растит тень" },
  { id: "corp_tax", section: "taxes", name: "Налог на прибыль фирм", defaultValue: 0.18, minValue: 0, maxValue: 0.40, effectNote: "Снижает интерес частников к 90% доле заводов" },
  { id: "property_tax", section: "taxes", name: "Налог на недвижимость (год)", defaultValue: 0.003, minValue: 0, maxValue: 0.02, effectNote: "Финансирует службы, повышает нагрузку жилья" },
  { id: "import_duty", section: "taxes", name: "Ввозная пошлина", defaultValue: 0.06, minValue: 0, maxValue: 1.00, requiresNoticeWindowAbove: 0.50, effectNote: ">25% контрабанда; >50% окно уведомления 3–6 дней" },
  { id: "export_duty", section: "taxes", name: "Вывозная пошлина", defaultValue: 0.01, minValue: 0, maxValue: 0.30, effectNote: "Экспортный сбор на сырьё Контура Б" },
  { id: "unemployment_benefit", section: "social", name: "Пособие по безработице", defaultValue: 0.40, minValue: 0, maxValue: 0.80, effectNote: "Доля прежней зарплаты семьям в кризисе" },
  { id: "pension_monthly", section: "social", name: "Базовая пенсия (в мес.)", defaultValue: 1000, minValue: 440, maxValue: 2600, effectNote: "Индексируется на инфляцию (кроме программы МВФ)" },
  { id: "retirement_age", section: "social", name: "Пенсионный возраст", defaultValue: 65, minValue: 60, maxValue: 70, effectNote: "+1 год снижает приток пенсионеров ~на 2%" },
  { id: "npf_rate", section: "social", name: "Накопительный взнос НПФ", defaultValue: 0, minValue: 0, maxValue: 0.10, effectNote: "Формирует пенсионный резерв" },
  { id: "city_plant_share", section: "business", name: "Доля Мэрии в новых заводах", defaultValue: 0.10, minValue: 0.10, maxValue: 1.00, effectNote: "Правило 10% / 90% (до 100% госкомпании)" },
  { id: "credit_subsidy", section: "business", name: "Субсидия ставки кредита бизнесу", defaultValue: 0, minValue: 0, maxValue: 0.05, effectNote: "Казна компенсирует банкам до 5 п.п." },
  { id: "cb_key_rate", section: "central_bank", name: "Ключевая ставка ЦБ", defaultValue: 0.07, minValue: 0.01, maxValue: 0.40, effectNote: "Задаёт депозиты (-3 п.п.), ипотеку (+1 п.п.), бизнес (+3 п.п.)" },
  { id: "cb_reserve_ratio", section: "central_bank", name: "Норма обязательных резервов", defaultValue: 0.05, minValue: 0, maxValue: 0.20, effectNote: "Ограничивает кредитный мультипликатор банков" },
  { id: "cb_bond_share", section: "central_bank", name: "Покупка гособлигаций ЦБ (эмиссия)", defaultValue: 0, minValue: 0, maxValue: 1.00, effectNote: "Прямая печать денег; запрещена при МВФ" },
  { id: "cb_fx_intervention", section: "central_bank", name: "Валютные интервенции ЦБ", defaultValue: 0.30, minValue: 0, maxValue: 1.00, effectNote: "Сглаживает курс за счёт резервов МРЕ" },
  { id: "swf_sterilization", section: "central_bank", name: "Стерилизация в Суверенный Фонд (SWF)", defaultValue: 0, minValue: 0, maxValue: 0.80, effectNote: "Хранит экспортную выручку в МРЕ против голландской болезни" },
] as const;

/** Quality Index 1★–5★ calculator (Sheet 12 `City Systems` Section 5, GDD §4.2). */
export function computeProductQuality(params: {
  facilityLevel: number; // 1..5
  engineerShare: number; // 0..1
  technoparkCount: number; // 0..2
  rawPurityFactor?: number; // default 1.0
}): { score: number; stars: 1 | 2 | 3 | 4 | 5; priceMultiplier: number } {
  const purity = params.rawPurityFactor ?? 1.0;
  const base =
    1.0 +
    Math.max(0, params.facilityLevel - 1) * 0.4 +
    Math.max(0, Math.min(1, params.engineerShare)) * 6.0 +
    Math.min(2, Math.max(0, params.technoparkCount)) * 0.5;
  const score = Math.max(1.0, Math.min(5.0, base * purity));
  if (score >= 4.5) return { score, stars: 5, priceMultiplier: 1.5 };
  if (score >= 3.5) return { score, stars: 4, priceMultiplier: 1.3 };
  if (score >= 2.5) return { score, stars: 3, priceMultiplier: 1.0 };
  if (score >= 1.5) return { score, stars: 2, priceMultiplier: 0.9 };
  return { score, stars: 1, priceMultiplier: 0.75 };
}

export interface HappinessFactors {
  readonly money: number;       // weight 0.20
  readonly jobs: number;        // weight 0.12
  readonly housing: number;     // weight 0.12
  readonly safety: number;      // weight 0.10
  readonly health: number;      // weight 0.10
  readonly education: number;   // weight 0.08
  readonly environment: number; // weight 0.08
  readonly transport: number;   // weight 0.08
  readonly utilities: number;   // weight 0.06
  readonly leisure: number;     // weight 0.04
  readonly policy: number;      // weight 0.02
}

/** 11-factor weighted Happiness Index H in [0..100] (Sheet 09 `Map & Growth` Section 5, GDD §6.7). */
export function computeHappinessIndex(f: HappinessFactors): number {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const h =
    clamp(f.money) * 0.2 +
    clamp(f.jobs) * 0.12 +
    clamp(f.housing) * 0.12 +
    clamp(f.safety) * 0.1 +
    clamp(f.health) * 0.1 +
    clamp(f.education) * 0.08 +
    clamp(f.environment) * 0.08 +
    clamp(f.transport) * 0.08 +
    clamp(f.utilities) * 0.06 +
    clamp(f.leisure) * 0.04 +
    clamp(f.policy) * 0.02;
  return Math.max(0, Math.min(100, h));
}

export interface HegemonyRegionMetrics {
  readonly sectorId: SectorId;
  readonly gdpInWcu: number;
  readonly swfAndReservesInWcu: number;
  readonly megaprojectEquityShare: number;
  readonly households: number;
  readonly happinessIndex: number;
  readonly avgLandValueUnits: number;
  readonly freightAndTransitVolumeTons: number;
  readonly tier3And4OutputInWcu: number;
  readonly avgProductQualityStars: number;
}

export interface HegemonyScoreBreakdown {
  readonly sectorId: SectorId;
  readonly financialAndIndustrial: number; // max 300
  readonly citizenProsperityAndLand: number; // max 250
  readonly logisticsAndTransit: number; // max 250
  readonly techLeadership: number; // max 200
  readonly totalPoints: number; // max 1000 across normalized baskets
}

/**
 * Seasonal 1,000-Point Hegemony Index across the 5 sectors (GDD §9.1):
 * 300 Financial & Industrial + 250 Citizen Prosperity & Land Value +
 * 250 Logistics & Transit + 200 Tier 3–4 Tech Leadership.
 */
export function computeHegemonyScores(
  metrics: readonly HegemonyRegionMetrics[]
): HegemonyScoreBreakdown[] {
  if (metrics.length === 0) return [];
  const maxFin = Math.max(
    1,
    ...metrics.map(
      (m) => m.gdpInWcu + m.swfAndReservesInWcu * 0.5 + m.megaprojectEquityShare * 5e8
    )
  );
  const maxPros = Math.max(
    1,
    ...metrics.map((m) => m.households * (m.happinessIndex / 100) * (1 + m.avgLandValueUnits / 500_000))
  );
  const maxLog = Math.max(1, ...metrics.map((m) => m.freightAndTransitVolumeTons));
  const maxTech = Math.max(
    1,
    ...metrics.map((m) => m.tier3And4OutputInWcu * (m.avgProductQualityStars / 3))
  );

  return metrics.map((m) => {
    const finRaw = m.gdpInWcu + m.swfAndReservesInWcu * 0.5 + m.megaprojectEquityShare * 5e8;
    const prosRaw =
      m.households * (m.happinessIndex / 100) * (1 + m.avgLandValueUnits / 500_000);
    const logRaw = m.freightAndTransitVolumeTons;
    const techRaw = m.tier3And4OutputInWcu * (m.avgProductQualityStars / 3);

    const financialAndIndustrial = Math.round((finRaw / maxFin) * 300);
    const citizenProsperityAndLand = Math.round((prosRaw / maxPros) * 250);
    const logisticsAndTransit = Math.round((logRaw / maxLog) * 250);
    const techLeadership = Math.round((techRaw / maxTech) * 200);
    return {
      sectorId: m.sectorId,
      financialAndIndustrial,
      citizenProsperityAndLand,
      logisticsAndTransit,
      techLeadership,
      totalPoints:
        financialAndIndustrial +
        citizenProsperityAndLand +
        logisticsAndTransit +
        techLeadership,
    };
  });
}
