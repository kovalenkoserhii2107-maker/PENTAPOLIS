/**
 * Three Advisors: Urban Planning, Finance (Central Bank) and Logistics (Sprint 6, GDD §6.6).
 *
 * After the 4 starter quests the advisors keep reading the live state of the sector and tell the
 * mayor what hurts most, in priority order, with the lever that fixes it.
 */
import type {
  ActiveEmergencyDto,
  AdvisorDto,
  AdvisorTipDto,
  SectorAutoStatsDto,
  SectorCityStatsDto,
  SectorConstructionStatsDto,
  SectorSummaryDto,
  SectorTransportStatsDto,
} from "../protocol.ts";

export interface AdvisorInput {
  readonly sector: SectorSummaryDto;
  readonly city: SectorCityStatsDto | undefined;
  readonly transport: SectorTransportStatsDto | undefined;
  readonly construction: SectorConstructionStatsDto | undefined;
  readonly autos: SectorAutoStatsDto | undefined;
  readonly emergencies: readonly ActiveEmergencyDto[];
  readonly hasBuilding: (catalogId: string) => boolean;
}

const RANK: Readonly<Record<AdvisorTipDto["severity"], number>> = { critical: 0, warning: 1, info: 2 };
const pct = (v: number) => `${Math.round(v * 100)}%`;

function finish(tips: AdvisorTipDto[], fallback: string): AdvisorTipDto[] {
  const sorted = tips.sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, 4);
  return sorted.length > 0 ? sorted : [{ severity: "info", text: fallback, hint: "" }];
}

export function buildAdvisors(input: AdvisorInput): AdvisorDto[] {
  const { sector, city, transport, construction, autos } = input;

  // ---------------------------------------------------------------- Urban planning
  const urban: AdvisorTipDto[] = [];
  if (city && city.residents > 0) {
    const cov = city.coverage;
    if (cov.fire < 0.5) {
      urban.push({ severity: "critical", text: `Пожарная охрана покрывает только ${pct(cov.fire)} жителей`, hint: "Постройте Пожарное депо SAF-02 у жилых кварталов" });
    }
    if (cov.police < 0.5) {
      urban.push({ severity: "warning", text: `Преступность ${pct(city.avgCrimeRate)}, полиция покрывает ${pct(cov.police)} жителей`, hint: "Полицейский участок SAF-01 снижает преступность на 45%" });
    }
    if (cov.health < 0.5) {
      urban.push({ severity: "warning", text: `Медпомощь доступна ${pct(cov.health)} жителей`, hint: "Поликлиника HLT-01 или Больница HLT-02 (+14–30% к цене земли)" });
    }
    if (cov.kindergarten < 0.5 || cov.school < 0.5) {
      urban.push({ severity: "warning", text: `Детсады ${pct(cov.kindergarten)}, школы ${pct(cov.school)} покрытия`, hint: "Без детсада один родитель сидит дома; школа выпускает рабочих (GDD §6.2)" });
    }
    if (city.avgEcology < 0.45) {
      urban.push({ severity: "warning", text: `Экология ${pct(city.avgEcology)}: дым роняет цену земли`, hint: "Парк CIV-03, указ «Субсидия на газификацию» или вынос заводов от жилья" });
    }
    if (city.avgLandValuePerTile > 0) {
      urban.push({
        severity: "info",
        text: `Средняя цена земли $${city.avgLandValuePerTile.toLocaleString("ru-RU")}/тайл, счастье районов ${city.districtHappiness}`,
        hint: "Элитные районы (уровни 4–5) требуют полного покрытия службами",
      });
    }
  }
  if (construction && construction.stalledSites > 0) {
    urban.push({ severity: "warning", text: `${construction.stalledSites} стройплощадок стоят без материалов`, hint: "См. «Стройка девелоперов»: свои заводы или дорога к шлюзу" });
  }
  if (!input.hasBuilding("SAF-02") && urban.every((t) => !t.text.includes("Пожар"))) {
    urban.push({ severity: "info", text: "Первые кварталы скоро загорятся без пожарного депо", hint: "SAF-02 открывается на этапе S1" });
  }

  // ---------------------------------------------------------------- Finance / central bank
  const finance: AdvisorTipDto[] = [];
  const treasury = Number(BigInt(sector.treasuryBalanceMinor) / 100n);
  if (treasury < 500_000) {
    finance.push({ severity: "critical", text: `В казне всего ${sector.currencySymbol} ${treasury.toLocaleString("ru-RU")}`, hint: "Сократите стройку Контура Б или поднимите НДС/налог на прибыль" });
  }
  const gap = sector.annualInflation - (sector.keyRate - 0.02);
  if (sector.annualInflation > 0.08) {
    finance.push({ severity: "warning", text: `Инфляция ${pct(sector.annualInflation)} при ставке ЦБ ${pct(sector.keyRate)}`, hint: "Правило Тейлора: ставка ≥ инфляция + 2 п.п." });
  } else if (gap < -0.04) {
    finance.push({ severity: "info", text: `Ставка ЦБ ${pct(sector.keyRate)} душит рост при инфляции ${pct(sector.annualInflation)}`, hint: "Снижение ставки удешевит кредиты заводам 10%/90%" });
  }
  if (sector.creditRating === "B" || sector.creditRating === "BB") {
    finance.push({ severity: "warning", text: `Кредитный рейтинг ${sector.creditRating}, долг/доход ${sector.debtToRevenue}`, hint: "Высокий спред по облигациям; МВФ — крайняя мера" });
  }
  if (sector.powerSupplyMw < sector.powerDemandMw) {
    finance.push({ severity: "critical", text: `Дефицит энергии: ${sector.powerDemandMw} МВт спроса при ${sector.powerSupplyMw} МВт`, hint: "Постройте ТЭЦ/ГЭС (ENG): иначе веерные отключения" });
  }
  if (sector.cbBondPurchaseShare > 0.3) {
    finance.push({ severity: "warning", text: `ЦБ печатает деньги: выкуп ${pct(sector.cbBondPurchaseShare)} облигаций`, hint: "Через 2–3 месяца это разгонит инфляцию" });
  }

  // ---------------------------------------------------------------- Logistics
  const logistics: AdvisorTipDto[] = [];
  if (construction && !construction.gatewayImportOpen) {
    logistics.push({ severity: "critical", text: "Город не соединён дорогой со стартовым шлюзом", hint: "Протяните улицу к Внешнему шоссе/туннелю: без него нет импорта" });
  }
  if (transport) {
    if (transport.avgRoadHealth < 60) {
      logistics.push({ severity: "warning", text: `Средняя прочность дорог ${transport.avgRoadHealth}%`, hint: "Ремонт в панели «Транспорт» или Дорожная служба «Усиленный»" });
    }
    if (transport.congestedSegments > 0) {
      logistics.push({ severity: "warning", text: `${transport.congestedSegments} участков в пробках`, hint: "Проспект 4 полосы, автобусы или метро разгрузят улицы" });
    }
    if (transport.truckTripsPerHour > 2 && transport.roadServiceLevel === 0) {
      logistics.push({ severity: "warning", text: "Фуры ломают дороги, а Дорожная служба отключена", hint: "Указ «Весовой контроль фур» (−25% износа) или промышленная трасса" });
    }
    if (transport.busRoutes === 0 && (city?.residents ?? 0) > 1500) {
      logistics.push({ severity: "info", text: "Нет ни одного автобусного маршрута", hint: "Депо TRN-02 + остановки TRN-01 снимут до 25% машин с улиц" });
    }
  }
  if (autos && autos.strandedPerMonth > 0) {
    logistics.push({ severity: "info", text: `${autos.strandedPerMonth} сломанных машин в месяц остаются без ремонта`, hint: "Частные СТО (BIZ-01) открываются в торговых зонах" });
  }

  const fireNow = input.emergencies.filter((e) => e.emergencyId !== "FROZEN_CONSTRUCTION" && !e.attended);
  if (fireNow.length > 0) {
    urban.unshift({ severity: "critical", text: `ЧП без выезда служб: ${fireNow.map((e) => e.titleRu.split(":")[0]).join(", ")}`, hint: "Постройте нужную службу рядом — без неё ЧП тянется втрое дольше" });
  }

  return [
    { advisorId: "urban", nameRu: "Советник по градостроительству", tips: finish(urban, "Кварталы под контролем. Размечайте новые зоны вдоль дорог.") },
    { advisorId: "finance", nameRu: "Советник по финансам (ЦБ)", tips: finish(finance, "Бюджет и курс стабильны.") },
    { advisorId: "logistics", nameRu: "Советник по логистике", tips: finish(logistics, "Дороги и снабжение в порядке.") },
  ];
}
