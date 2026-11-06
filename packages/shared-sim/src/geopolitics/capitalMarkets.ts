/**
 * Megaprojects of the Central Core & the Regional Stock Exchange (Sprint 7, GDD §9.1, §3.1, §3.2).
 *
 * Megaprojects (MEG-01..03) are joint ventures in the neutral Central Core. Any mayor may found
 * one; construction starts once contributions — from the treasury or the Sovereign Wealth Fund in
 * WCU — cover its cost. Each contributor owns equity in proportion to what they paid and receives
 * dividends for life; the Fusion Complex also feeds its owners' grids.
 *
 * Exchange: with a Regional Exchange Floor (FIN-02) a sector lists its plants. A mayor can
 * privatise part of the city's stake, buy private shares back, or — usually with SWF money — buy
 * into a neighbour's listed plants and collect dividends across the border.
 */
import type { MasterCatalogs } from "../catalogs/index.ts";
import { computeBuildingAtLevel } from "../catalogs/buildings.ts";
import type { SectorId } from "../catalogs/visuals.ts";
import { mulRate, type Money } from "../money/money.ts";
import type { BuildingDto, ListedCompanyDto, MegaprojectDto, MegaprojectResourceId } from "../protocol.ts";

/** Megaproject dividend: 0.8% of its cost per game month, shared by equity. */
export const MEGAPROJECT_MONTHLY_YIELD = 0.008;
/** Fusion Complex output shared among its owners (MW). */
export const FUSION_OUTPUT_MW = 3000;
/** Plants that can be listed once the sector has an exchange floor. */
export const LISTABLE_PREFIXES = ["EXT", "PRO", "CMP", "ASM", "ENG"] as const;
/** Contour-B enterprises' expected return when privatised (GDD §3.5 calibration). */
export const CONTOUR_B_EXPECTED_ROI = 0.12;
/** Foreign stake threshold triggering a hostile-takeover notice window (GDD §3.2). */
export const FOREIGN_TAKEOVER_NOTICE_THRESHOLD = 0.25;
/** Hostile takeover notice window duration in game days (3–6 game days). */
export const FOREIGN_TAKEOVER_NOTICE_DAYS = 4;

export type MegaprojectCatalogId = "MEG-01" | "MEG-02" | "MEG-03" | "MEG-04";

export interface MegaprojectSpec {
  readonly catalogId: MegaprojectCatalogId;
  readonly nameRu: string;
  readonly costWcuMinor: Money;
  readonly buildTimeGameHours: number;
  readonly bonusSummaryRu: string;
  readonly requiredResources: Readonly<Record<MegaprojectResourceId, number>>;
  readonly corePad: { readonly tileX: number; readonly tileY: number; readonly width: number; readonly depth: number };
}

export const MEGAPROJECT_RESOURCE_NAMES_RU: Readonly<Record<MegaprojectResourceId, string>> = {
  Steel: "Сталь",
  Cement: "Цемент",
  Microchips: "Микрочипы",
  "Industrial Machinery": "Пром. станки",
};

export const MEGAPROJECT_SPECS: Readonly<Record<MegaprojectCatalogId, MegaprojectSpec>> = {
  "MEG-01": {
    catalogId: "MEG-01",
    nameRu: "Континентальный мега-мост / тоннель",
    costWcuMinor: 150_000_000_000n,
    buildTimeGameHours: 2160,
    bonusSummaryRu: "−50% внешняя логистика, ×2 элитных туристов, +45 очков Гегемонии",
    requiredResources: { Steel: 40_000, Cement: 60_000, Microchips: 1_500, "Industrial Machinery": 2_000 },
    corePad: { tileX: 465, tileY: 465, width: 20, depth: 20 },
  },
  "MEG-02": {
    catalogId: "MEG-02",
    nameRu: "Термоядерный энергокомплекс",
    costWcuMinor: 250_000_000_000n,
    buildTimeGameHours: 2160,
    bonusSummaryRu: "3 000 МВт чистой энергии дольщикам пропорционально вкладу, +60 очков Гегемонии",
    requiredResources: { Steel: 30_000, Cement: 25_000, Microchips: 5_000, "Industrial Machinery": 2_000 },
    corePad: { tileX: 515, tileY: 465, width: 20, depth: 20 },
  },
  "MEG-03": {
    catalogId: "MEG-03",
    nameRu: "Международный финансово-космический центр",
    costWcuMinor: 200_000_000_000n,
    buildTimeGameHours: 2160,
    bonusSummaryRu: "Постоянный спрос на товары Tier 3–4, +8% ВВП финансового сектора, +50 очков Гегемонии",
    requiredResources: { Steel: 20_000, Cement: 30_000, Microchips: 8_000, "Industrial Machinery": 1_500 },
    corePad: { tileX: 465, tileY: 515, width: 20, depth: 20 },
  },
  "MEG-04": {
    catalogId: "MEG-04",
    nameRu: "Международный техно-коллайдер",
    costWcuMinor: 180_000_000_000n,
    buildTimeGameHours: 2160,
    bonusSummaryRu: "+15% науки и качества товаров Tier 3–4 (до 5★), +10% ВВП, +65 очков Гегемонии",
    requiredResources: { Steel: 25_000, Cement: 35_000, Microchips: 6_000, "Industrial Machinery": 3_000 },
    corePad: { tileX: 515, tileY: 515, width: 20, depth: 20 },
  },
};

export interface MegaprojectStakeRecord {
  readonly buildingId: string;
  readonly sectorId: SectorId;
  readonly contributedWcu: Money;
}

export function megaprojectStatus(
  b: BuildingDto,
  catalogs: MasterCatalogs,
  stakes: readonly MegaprojectStakeRecord[],
  explicitDeliveries?: Partial<Record<MegaprojectResourceId, number>>
): MegaprojectDto {
  const entry = catalogs.buildingsById.get(b.catalogId);
  const spec = MEGAPROJECT_SPECS[b.catalogId as MegaprojectCatalogId];
  const mine = stakes.filter((s) => s.buildingId === b.id);
  const funded = mine.reduce((sum, s) => sum + s.contributedWcu, 0n);
  const cost = entry?.buildCostLv1 ?? spec?.costWcuMinor ?? 180_000_000_000n;
  const status: MegaprojectDto["status"] =
    funded < cost ? "funding" : b.constructionProgress < 1 ? "building" : "operational";
  const fundedRatio = cost > 0n ? Math.min(1, Number((funded * 10_000n) / cost) / 10_000) : 0;
  const req = spec?.requiredResources ?? { Steel: 25_000, Cement: 35_000, Microchips: 5_000, "Industrial Machinery": 2_000 };
  const delivered: Record<MegaprojectResourceId, number> = {
    Steel: Math.min(req.Steel, Math.max(Math.round(explicitDeliveries?.Steel ?? 0), Math.round(req.Steel * fundedRatio))),
    Cement: Math.min(req.Cement, Math.max(Math.round(explicitDeliveries?.Cement ?? 0), Math.round(req.Cement * fundedRatio))),
    Microchips: Math.min(req.Microchips, Math.max(Math.round(explicitDeliveries?.Microchips ?? 0), Math.round(req.Microchips * fundedRatio))),
    "Industrial Machinery": Math.min(
      req["Industrial Machinery"],
      Math.max(Math.round(explicitDeliveries?.["Industrial Machinery"] ?? 0), Math.round(req["Industrial Machinery"] * fundedRatio))
    ),
  };

  return {
    buildingId: b.id,
    catalogId: b.catalogId,
    nameRu: entry?.nameRu ?? spec?.nameRu ?? b.catalogId,
    costWcuMinor: cost.toString(),
    fundedWcuMinor: funded.toString(),
    status,
    constructionProgress: b.constructionProgress,
    monthlyDividendWcuMinor: status === "operational" ? mulRate(cost, MEGAPROJECT_MONTHLY_YIELD).toString() : "0",
    bonusSummaryRu: spec?.bonusSummaryRu ?? entry?.mainOutput,
    requiredResources: req,
    deliveredResources: delivered,
    stakes: mine
      .filter((s) => s.contributedWcu > 0n)
      .map((s) => ({
        sectorId: s.sectorId,
        contributedWcuMinor: s.contributedWcu.toString(),
        share: funded > 0n ? Number((s.contributedWcu * 1_000_000n) / funded) / 1_000_000 : 0,
      })),
  };
}

/** Monthly megaproject dividends per sector, in WCU minor units (exact: remainder to the largest owner). */
export function megaprojectDividends(projects: readonly MegaprojectDto[]): Map<SectorId, Money> {
  const out = new Map<SectorId, Money>();
  for (const p of projects) {
    const pool = BigInt(p.monthlyDividendWcuMinor);
    if (pool === 0n || p.stakes.length === 0) continue;
    const funded = BigInt(p.fundedWcuMinor);
    let paid = 0n;
    const sorted = [...p.stakes].sort((a, b) => b.share - a.share);
    for (const s of sorted.slice(1)) {
      const part = (pool * BigInt(s.contributedWcuMinor)) / funded;
      paid += part;
      out.set(s.sectorId, (out.get(s.sectorId) ?? 0n) + part);
    }
    const top = sorted[0]!;
    out.set(top.sectorId, (out.get(top.sectorId) ?? 0n) + (pool - paid));
  }
  return out;
}

/** Fusion power each owner receives (MW). */
export function fusionPowerShares(projects: readonly MegaprojectDto[]): Map<SectorId, number> {
  const out = new Map<SectorId, number>();
  for (const p of projects) {
    if (p.catalogId !== "MEG-02" || p.status !== "operational") continue;
    for (const s of p.stakes) out.set(s.sectorId, (out.get(s.sectorId) ?? 0) + FUSION_OUTPUT_MW * s.share);
  }
  return out;
}

export interface ForeignStakeRecord {
  readonly buildingId: string;
  readonly holderSector: SectorId;
  share: number;
}

export interface ValuationInput {
  readonly catalogs: MasterCatalogs;
  readonly building: BuildingDto;
  readonly fxRatePerWcu: number;
  readonly keyRate: number;
  /** Expected ROI of a co-invested plant (from its factory project); Contour B uses the default. */
  readonly expectedRoi?: number;
  readonly foreignStakes: readonly ForeignStakeRecord[];
}

/**
 * Market valuation of a listed plant: book capital (Lv.1 cost + upgrades) times a multiple of its
 * return over the cost of capital (key rate + 3 p.p.), bounded to 0.4x–3x book.
 */
export function valueListedCompany(input: ValuationInput): ListedCompanyDto {
  const b = input.building;
  const entry = input.catalogs.buildingsById.get(b.catalogId)!;
  const stats = computeBuildingAtLevel(entry, input.catalogs.levelCurves, b.level);
  const book = mulRate(stats.cumulativeCapexFromLv1, input.fxRatePerWcu);
  const roi = input.expectedRoi ?? CONTOUR_B_EXPECTED_ROI;
  const multiple = Math.max(0.4, Math.min(3, roi / Math.max(0.01, input.keyRate + 0.03)));
  const cap = mulRate(book, multiple);
  const capWcu = mulRate(cap, 1 / Math.max(0.01, input.fxRatePerWcu));
  const foreign = input.foreignStakes.filter((f) => f.buildingId === b.id && f.share > 0);
  const foreignTotal = foreign.reduce((s, f) => s + f.share, 0);
  return {
    buildingId: b.id,
    catalogId: b.catalogId,
    sectorId: b.sectorId as SectorId,
    nameRu: entry.nameRu,
    level: b.level,
    annualRoi: Number(roi.toFixed(4)),
    marketCapLocalMinor: cap.toString(),
    marketCapWcuMinor: capWcu.toString(),
    pricePerPercentLocalMinor: mulRate(cap, 0.01).toString(),
    cityShare: Number(b.cityEquityShare.toFixed(4)),
    privateShare: Number(Math.max(0, 1 - b.cityEquityShare - foreignTotal).toFixed(4)),
    stalledAwaitingPrivate: b.stalledAwaitingPrivate,
    foreignStakes: foreign.map((f) => ({ sectorId: f.holderSector, share: Number(f.share.toFixed(4)) })),
  };
}

/** Monthly dividend on a listed company stake (local minor units of the company's sector). */
export function stakeMonthlyDividend(company: ListedCompanyDto, share: number): Money {
  return mulRate(BigInt(company.marketCapLocalMinor), (company.annualRoi / 12) * share);
}

export function isListable(catalogId: string): boolean {
  return (LISTABLE_PREFIXES as readonly string[]).includes(catalogId.slice(0, 3));
}
