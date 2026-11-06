/**
 * Five-Region Sovereign BigInt Double-Entry Money Engine (`RegionalMoneyEngine.ts`).
 *
 * Implements GDD Chapter 3 (§§3.1–3.5), Sheet 08 (`Regional Money Model`),
 * Sheet 11 (`Money Flow Model`), and Sheet 21 (`Factory Co-Investment 10%/90%`):
 * - 5 sovereign regions (Sectors 1–5), each with its own currency (led by ₴ UAH) + WCU (МРЕ);
 * - Pure `bigint` minor-unit double-entry accounting across 7 columns:
 *     `[HH, Fc, Fk, T, Banks, CB, World]`;
 * - 4 iron invariants verified on every monthly step (`0n` exact minor-unit diff):
 *     1) Every row sums to `0n`;
 *     2) Every column sums to `0n`;
 *     3) `CB` column converges independently without a forced plug;
 *     4) `Δ(Dh + Df)` equals net bank credit + CB monetisation + net FX balance of payments;
 * - 10% / 90% Factory Co-Investment, private ROI market check, 100% municipal buyout backstop,
 *   and proportional / state-dilutive Lv.2–5 upgrades;
 * - Mayor's Central Bank (key rate / Taylor rule, reserve ratio, CB bond buying, FX intervention,
 *   Sovereign Wealth Fund 0–80% WCU sterilization);
 * - Sovereign credit rating (`AAA`, `BBB`, `BB`, `B`) & IMF Bailout Facility (4 WCU tranches,
 *   mandatory austerity conditions);
 * - Hostile Action Notice Window (3–6 game days delay for tariffs > 50% / embargoes / transit cuts),
 *   contraband shadow leakage, resource concessions (15% royalty), and AI Caretaker Governor (48h AFK).
 */
import {
  absBig,
  allocate,
  maxBig,
  money,
  mulRate,
  toUnits,
  type Money,
} from "../money/money.ts";
import {
  DEFAULT_SECTOR_CURRENCIES,
  validateSeasonCurrencies,
  type CurrencyCode,
} from "../money/currencies.ts";
import type { SectorId } from "../catalogs/visuals.ts";
import { computeHappinessIndex } from "../catalogs/sectorsAndLevers.ts";

export const MATRIX_COLUMNS = ["HH", "Fc", "Fk", "T", "Banks", "CB", "World"] as const;
export type MatrixColumn = (typeof MATRIX_COLUMNS)[number];

export type LedgerMatrixRow = readonly [
  label: string,
  HH: Money,
  Fc: Money,
  Fk: Money,
  T: Money,
  Banks: Money,
  CB: Money,
  World: Money,
];

export type CreditRating = "AAA" | "BBB" | "BB" | "B";

export type MayorPolicyPreset = "taylor" | "populist" | "hawk" | "manual" | "ai_governor";

export interface HouseholdClassState {
  readonly id: "workers" | "engineers" | "elite" | "retirees";
  readonly name: string;
  households: number;
  wageUnits: number; // real base wage in currency units before CPI scaling, updated with inflation
  pensionUnits: number;
  housingUnits: number;
  foodUnits: number;
  goodsUnits: number;
  utilitiesUnits: number;
  transportUnits: number;
  propertyTaxUnits: number;
  pitRate: number;
  dividendShare: number;
  insuranceUnits: number;
  leisureUnits: number;
  deposits: Money; // stock in local minor units
  migrationFloorUnits: number;
}

export type FactoryProjectStatus = "awaiting_private_investors" | "operational";

export interface FactoryEquityProject {
  readonly projectId: string;
  readonly buildingCatalogId: string;
  readonly sectorId: SectorId;
  level: number;
  status: FactoryProjectStatus;
  totalCapexCommitted: Money;
  cityShare: number; // 0.10 .. 1.00
  privateShare: number; // 0.90 .. 0.00
  expectedAnnualRoi: number; // e.g. 0.14 (14%)
  pendingCityCapexThisMonth: Money;
  pendingPrivateCapexThisMonth: Money;
}

export interface PendingHostileNotice {
  readonly id: string;
  readonly sourceSector: SectorId;
  readonly targetSector: SectorId | "outer_world";
  readonly actionType: "import_tariff_hike" | "border_embargo" | "gas_transit_shutoff";
  readonly proposedValue: number;
  activatesAtGameDay: number; // 3..6 game days after filing (GDD §1.4)
  readonly descriptionRu: string;
}

export interface ResourceConcessionContract {
  readonly contractId: string;
  readonly landownerSector: SectorId;
  readonly operatorSector: SectorId;
  readonly resourceName: string;
  readonly monthlyExtractedValueWcu: number;
  readonly royaltyRate: number; // default 0.15 (GDD §2.3)
  monthsRemaining: number; // 12 months contract
}

export interface ImfProgrammeState {
  active: boolean;
  totalApprovedWcu: Money; // in WCU minor units
  debtPrincipalWcu: Money;
  tranchesDisbursed: number; // 0..4
  monthsSinceActivation: number;
}

export interface RegionPolicyLevers {
  preset: MayorPolicyPreset;
  keyRate: number; // 0.01 .. 0.40
  useTaylorAdvisor: boolean;
  reserveRequirement: number; // 0.00 .. 0.20 (default 0.05)
  cbBondPurchaseShare: number; // 0.00 .. 1.00 (default 0.00)
  fxInterventionShare: number; // 0.00 .. 1.00 (default 0.30)
  swfSterilizationShare: number; // 0.00 .. 0.80 (default 0.00)
  vatRate: number; // default 0.10
  corpTaxRate: number; // default 0.18
  importDutyRate: number; // default 0.06
  exportDutyRate: number; // default 0.01
  unemploymentBenefitRate: number; // default 0.40
  retirementAge: number; // default 65
  cityNewPlantShare: number; // default 0.10 (Rule 10% / 90%)
  creditSubsidyRate: number; // 0.00 .. 0.05
  publicSpendingMultiplier: number; // default 1.00
  pensionIndexationEnabled: boolean;
  activeDecreeIds: string[];
}

export interface LedgerInvariantCheck {
  readonly valid: boolean;
  readonly maxRowError: Money;
  readonly maxColError: Money;
  readonly cbColumnIndependentSum: Money;
  readonly moneyDecompositionDiff: Money;
}

export interface RegionMonthlyReport {
  readonly month: number;
  readonly sectorId: SectorId;
  readonly currency: CurrencyCode;
  readonly fxRatePerWcu: number; // local currency units per 1 WCU
  readonly cpi: number;
  readonly annualInflation: number;
  readonly keyRate: number;
  readonly businessLoanRate: number;
  readonly mortgageRate: number;
  readonly depositRate: number;
  readonly bondYield: number;
  readonly creditRating: CreditRating;
  readonly households: number;
  readonly hardshipShare: number;
  readonly happinessIndex: number;
  readonly vacancyRate: number;
  readonly rentIndex: number;
  readonly gdpLocal: Money;
  readonly gdpWcu: number;
  readonly treasuryRevenue: Money;
  readonly treasuryExpenditure: Money;
  readonly budgetBalance: Money;
  readonly govDebt: Money;
  readonly debtToAnnualRevenue: number;
  readonly fxReservesWcu: Money;
  readonly fxReservesMonthsOfImports: number;
  readonly swfBalanceWcu: Money;
  readonly imfActive: boolean;
  readonly imfDebtWcu: Money;
  readonly bankCapitalRatio: number;
  readonly bankWillingnessToLend: number;
  readonly newBusinessCreditIndex: number;
  readonly businessInvestmentIndex: number;
  readonly stateEquityShareEffective: number;
  readonly smugglingLeakageShare: number;
  readonly matrix: readonly LedgerMatrixRow[];
  readonly invariants: LedgerInvariantCheck;
}

export interface RegionEconomyState {
  readonly sectorId: SectorId;
  cityName: string;
  mayorUid: string | null;
  mayorDisplayName: string;
  isAiGovernor: boolean;
  lastMayorActivityEpochMs: number;
  currency: CurrencyCode;
  fxRatePerWcu: number; // starts at 1.00 local per 1 WCU
  cpi: number;
  rentIndex: number;
  inflationHistory: number[]; // monthly inflation observations
  classes: HouseholdClassState[];
  householdDeposits: Money;
  firmDeposits: Money;
  firmLoans: Money;
  mortgages: Money;
  govBondsBanks: Money;
  govBondsCb: Money;
  cbRefinancing: Money;
  bankCapital: Money;
  fxReservesWcu: Money;
  swfBalanceWcu: Money;
  treasuryCashAtCb: Money;
  debtToRevenueRatio: number;
  dwellings: number;
  hardshipShare: number;
  happinessIndex: number;
  imf: ImfProgrammeState;
  levers: RegionPolicyLevers;
  factories: FactoryEquityProject[];
  /** Intra-month double-entry rows queued for the current month's 7-column matrix (`SUM(row) == 0n`). */
  pendingCustomRows: LedgerMatrixRow[];
  /** Asymmetric sector shares from Sheet 14 `Regional Balance` */
  readonly baseShares: {
    readonly householdsShare: number;
    readonly outerExportShare: number;
    readonly outerImportShare: number;
    readonly tourismShare: number;
    readonly interPlayerSalesShare: number;
    readonly interPlayerPurchasesShare: number;
  };
  lastReport: RegionMonthlyReport | null;
}

export interface PeninsulaEconomyConfig {
  readonly currencies?: readonly [
    CurrencyCode,
    CurrencyCode,
    CurrencyCode,
    CurrencyCode,
    CurrencyCode,
  ];
  readonly policies?: Partial<Record<SectorId, MayorPolicyPreset>>;
  /** `"mature"` = Sheet 08/11 275k-household peninsula baseline; `"greenfield"` = $10M 90-household start. */
  readonly mode?: "mature" | "greenfield";
}

/** Baseline peninsula constants from Sheet 11 `Money Flow Model`. */
const PENINSULA_BASE = {
  outerExportsWcu: 260_000_000,
  outerImportsWcu: 245_000_000,
  interPlayerTradeWcu: 86_100_000,
  tourismWcu: 24_000_000,
  visaWcu: 3_510_000,
  govContracts: 175_000_000,
  govPrograms: 9_100_000,
  subsidies: 4_900_000,
  eminentDomain: 6_000_000,
  capex: 140_000_000,
  newHousing: 60_000_000,
  newMortgages: 25_000_000,
  firmDepChange: 10_000_000,
  migrantSavingsWcu: 2_000_000,
  evadedDutiesBase: 2_481_710,
  shadowMarginShare: 0.50,
  payoutRatio: 0.60,
  contourBStateShare: 0.28, // GDD §3.5: ~28% Contour B + ~7% processing co-investment = 35%
  wageFirmsShare: 0.80,
  wagePublicShare: 0.17,
  wageBanksShare: 0.03,
  insuranceLossRatio: 0.65,
  wealthSpendMonthlyShare: 0.004,
  mortDefaultAnnual: 0.012,
  firmDefaultAnnual: 0.025,
  minBankCapitalRatio: 0.08,
  fullLendingCapitalRatio: 0.12,
  recapTriggerCapitalRatio: 0.11,
  baseDwellingPrice: (765 * 12) / 0.08, // $114,750
} as const;

/** Asymmetric sector macro shares from Sheet 14 `Regional Balance`. */
const SECTOR_MACRO_SHARES: Readonly<
  Record<SectorId, RegionEconomyState["baseShares"]>
> = {
  1: { householdsShare: 0.22, outerExportShare: 0.25, outerImportShare: 0.18, tourismShare: 0.10, interPlayerSalesShare: 0.28, interPlayerPurchasesShare: 0.18 },
  2: { householdsShare: 0.18, outerExportShare: 0.30, outerImportShare: 0.15, tourismShare: 0.10, interPlayerSalesShare: 0.30, interPlayerPurchasesShare: 0.15 },
  3: { householdsShare: 0.22, outerExportShare: 0.15, outerImportShare: 0.20, tourismShare: 0.20, interPlayerSalesShare: 0.18, interPlayerPurchasesShare: 0.20 },
  4: { householdsShare: 0.18, outerExportShare: 0.10, outerImportShare: 0.22, tourismShare: 0.15, interPlayerSalesShare: 0.12, interPlayerPurchasesShare: 0.25 },
  5: { householdsShare: 0.20, outerExportShare: 0.20, outerImportShare: 0.25, tourismShare: 0.45, interPlayerSalesShare: 0.12, interPlayerPurchasesShare: 0.22 },
};

const DEMO_RATES = {
  baseRetireRateAt65: 1 / 45,
  retireeExitRate: 1 / 15,
  naturalEntryRate: 0.024,
  entryClassSplit: [0.70, 0.25, 0.05] as const,
  migrationSensitivity: 0.02,
  migrationCap: 0.02,
  jobLossMonthly: 0.006,
  gamblingMonthly: 0.0015,
  idlenessMonthly: 0.001,
  lifeCrisisMonthly: 0.002,
  recoveryMonthly: 0.15,
} as const;

export function computeCreditRating(debtToAnnualRevenue: number): {
  rating: CreditRating;
  spread: number;
} {
  if (debtToAnnualRevenue < 0.5) return { rating: "AAA", spread: 0.005 };
  if (debtToAnnualRevenue < 1.2) return { rating: "BBB", spread: 0.025 };
  if (debtToAnnualRevenue < 1.5) return { rating: "BB", spread: 0.05 };
  return { rating: "B", spread: 0.09 };
}

export function computeSmugglingRate(importDutyRate: number, embargoActive = false): number {
  if (embargoActive) return 0.38;
  if (importDutyRate <= 0.10) return 0.03 * (importDutyRate / 0.10);
  if (importDutyRate <= 0.25) return 0.03 + ((importDutyRate - 0.10) / 0.15) * 0.09;
  return Math.min(0.41, 0.12 + ((importDutyRate - 0.25) / 0.50) * 0.29);
}

function createDefaultLevers(preset: MayorPolicyPreset): RegionPolicyLevers {
  const base: RegionPolicyLevers = {
    preset,
    keyRate: 0.07,
    useTaylorAdvisor: preset === "taylor" || preset === "ai_governor",
    reserveRequirement: 0.05,
    cbBondPurchaseShare: 0.0,
    fxInterventionShare: 0.30,
    swfSterilizationShare: 0.0,
    vatRate: 0.10,
    corpTaxRate: 0.18,
    importDutyRate: 0.06,
    exportDutyRate: 0.01,
    unemploymentBenefitRate: 0.40,
    retirementAge: 65,
    cityNewPlantShare: 0.10,
    creditSubsidyRate: 0.0,
    publicSpendingMultiplier: 1.0,
    pensionIndexationEnabled: true,
    activeDecreeIds: [],
  };
  if (preset === "populist") {
    base.keyRate = 0.03;
    base.useTaylorAdvisor = false;
    base.cbBondPurchaseShare = 0.80;
    base.fxInterventionShare = 0.60;
  } else if (preset === "hawk") {
    base.keyRate = 0.12;
    base.useTaylorAdvisor = false;
    base.reserveRequirement = 0.08;
  }
  return base;
}

function createInitialRegionState(
  sectorId: SectorId,
  currency: CurrencyCode,
  preset: MayorPolicyPreset,
  mode: "mature" | "greenfield"
): RegionEconomyState {
  const sh = SECTOR_MACRO_SHARES[sectorId];
  const scaleFactor = mode === "greenfield" ? (90 / 275_000) : sh.householdsShare;
  const startDepositsTotal = 5_000_000_000 * scaleFactor;

  const classes: HouseholdClassState[] = [
    {
      id: "workers",
      name: "Workers & Operators",
      households: 148_750 * scaleFactor,
      wageUnits: 2200,
      pensionUnits: 0,
      housingUnits: 600,
      foodUnits: 550,
      goodsUnits: 320,
      utilitiesUnits: 180,
      transportUnits: 150,
      propertyTaxUnits: 15,
      pitRate: 0.12,
      dividendShare: 0,
      insuranceUnits: 30,
      leisureUnits: 120,
      deposits: money(0.15 * startDepositsTotal),
      migrationFloorUnits: 100,
    },
    {
      id: "engineers",
      name: "Engineers & Specialists",
      households: 68_750 * scaleFactor,
      wageUnits: 4800,
      pensionUnits: 0,
      housingUnits: 1100,
      foodUnits: 850,
      goodsUnits: 750,
      utilitiesUnits: 260,
      transportUnits: 340,
      propertyTaxUnits: 45,
      pitRate: 0.18,
      dividendShare: 0.15,
      insuranceUnits: 60,
      leisureUnits: 300,
      deposits: money(0.35 * startDepositsTotal),
      migrationFloorUnits: 600,
    },
    {
      id: "elite",
      name: "Entrepreneurs & Elite",
      households: 27_500 * scaleFactor,
      wageUnits: 6000,
      pensionUnits: 0,
      housingUnits: 2000,
      foodUnits: 1200,
      goodsUnits: 1800,
      utilitiesUnits: 400,
      transportUnits: 700,
      propertyTaxUnits: 180,
      pitRate: 0.24,
      dividendShare: 0.85,
      insuranceUnits: 180,
      leisureUnits: 900,
      deposits: money(0.45 * startDepositsTotal),
      migrationFloorUnits: 1500,
    },
    {
      id: "retirees",
      name: "Retirees & Unemployed",
      households: 30_000 * scaleFactor,
      wageUnits: 0,
      pensionUnits: 1000,
      housingUnits: 300,
      foodUnits: 380,
      goodsUnits: 120,
      utilitiesUnits: 120,
      transportUnits: 60,
      propertyTaxUnits: 10,
      pitRate: 0,
      dividendShare: 0,
      insuranceUnits: 15,
      leisureUnits: 60,
      deposits: money(0.05 * startDepositsTotal),
      migrationFloorUnits: 0,
    },
  ];

  const hhDeps = classes.reduce((s, c) => s + c.deposits, 0n);
  const monthlyImportsWcu =
    PENINSULA_BASE.outerImportsWcu *
    (mode === "greenfield" ? 90 / 275_000 : sh.outerImportShare) +
    PENINSULA_BASE.interPlayerTradeWcu *
      (mode === "greenfield" ? 90 / 275_000 : sh.interPlayerPurchasesShare);

  return {
    sectorId,
    cityName: `Сектор ${sectorId}`,
    mayorUid: null,
    mayorDisplayName: "Свободный слот",
    isAiGovernor: false,
    lastMayorActivityEpochMs: Date.now(),
    currency,
    fxRatePerWcu: 1.0,
    cpi: 1.0,
    rentIndex: 1.0,
    inflationHistory: [0.0025, 0.0025, 0.0025],
    classes,
    householdDeposits: hhDeps,
    firmDeposits: money(1_200_000_000 * scaleFactor),
    firmLoans: money(4_000_000_000 * scaleFactor),
    mortgages: money(3_000_000_000 * scaleFactor),
    govBondsBanks: money(
      mode === "greenfield" ? 0 : 1_500_000_000 * scaleFactor
    ),
    govBondsCb: money(mode === "greenfield" ? 0 : 300_000_000 * scaleFactor),
    cbRefinancing: money(500_000_000 * scaleFactor),
    bankCapital: money(900_000_000 * scaleFactor),
    fxReservesWcu: money(Math.max(10_000_000, monthlyImportsWcu * 3.3)),
    swfBalanceWcu: 0n,
    treasuryCashAtCb: mode === "greenfield" ? money(10_000_000) : 0n,
    debtToRevenueRatio: mode === "greenfield" ? 0 : 0.40,
    dwellings: 275_000 * scaleFactor * 1.03,
    hardshipShare: mode === "greenfield" ? 0.02 : 0.06,
    happinessIndex: 70,
    imf: {
      active: false,
      totalApprovedWcu: 0n,
      debtPrincipalWcu: 0n,
      tranchesDisbursed: 0,
      monthsSinceActivation: 0,
    },
    levers: createDefaultLevers(preset),
    factories: [],
    pendingCustomRows: [],
    baseShares: sh,
    lastReport: null,
  };
}

export class RegionalMoneyEngine {
  public month = 0;
  public currentGameDay = 1;
  public readonly regions: Map<SectorId, RegionEconomyState> = new Map();
  public readonly concessions: ResourceConcessionContract[] = [];
  public readonly pendingNotices: PendingHostileNotice[] = [];

  constructor(config: PeninsulaEconomyConfig = {}) {
    const currencies = config.currencies ?? DEFAULT_SECTOR_CURRENCIES;
    const check = validateSeasonCurrencies(currencies, true);
    if (!check.valid) {
      throw new Error(`Invalid season currency setup: ${check.reason}`);
    }
    const mode = config.mode ?? "mature";
    ([1, 2, 3, 4, 5] as const).forEach((sectorId, idx) => {
      const preset = config.policies?.[sectorId] ?? "taylor";
      const reg = createInitialRegionState(sectorId, currencies[idx]!, preset, mode);
      this.regions.set(sectorId, reg);
    });
  }

  public getRegion(sectorId: SectorId): RegionEconomyState {
    const r = this.regions.get(sectorId);
    if (!r) throw new Error(`Unknown sectorId ${sectorId}`);
    return r;
  }

  /**
   * Initiates a Tier 2–4 factory project under the 10% / 90% Co-Investment Rule (GDD §3.1).
   * - Mayor pays `cityShare` (default 10%, up to 100%) from Treasury;
   * - If `expectedAnnualRoi > currentBusinessLoanRate`, private investors immediately fund
   *   the remaining `1 - cityShare` and construction proceeds (`status = "operational"`);
   * - Otherwise the site stalls in `"awaiting_private_investors"` until market conditions
   *   improve or the Mayor invokes `mayorBuyoutFactory` (100% municipal backstop).
   */
  public createFactoryProject(params: {
    projectId: string;
    sectorId: SectorId;
    buildingCatalogId: string;
    buildCostLocal: Money;
    expectedAnnualRoi: number;
    cityShareOverride?: number;
  }): FactoryEquityProject {
    const reg = this.getRegion(params.sectorId);
    const cityShare = Math.min(
      1.0,
      Math.max(0.10, params.cityShareOverride ?? reg.levers.cityNewPlantShare)
    );
    const privateShare = Math.max(0, 1.0 - cityShare);
    const cityCapex = mulRate(params.buildCostLocal, cityShare);
    const privateCapex = params.buildCostLocal - cityCapex;

    const loanRate = Math.max(
      0.01,
      reg.levers.keyRate + 0.03 - reg.levers.creditSubsidyRate
    );
    const bankStress =
      reg.firmLoans + reg.mortgages > 0n &&
      toUnits(reg.bankCapital) / toUnits(reg.firmLoans + reg.mortgages) <
        PENINSULA_BASE.minBankCapitalRatio;
    const marketFavorable =
      privateShare === 0 || (!bankStress && params.expectedAnnualRoi > loanRate);

    const project: FactoryEquityProject = {
      projectId: params.projectId,
      buildingCatalogId: params.buildingCatalogId,
      sectorId: params.sectorId,
      level: 1,
      status: marketFavorable ? "operational" : "awaiting_private_investors",
      totalCapexCommitted: marketFavorable ? params.buildCostLocal : cityCapex,
      cityShare: marketFavorable ? cityShare : 1.0,
      privateShare: marketFavorable ? privateShare : 0.0,
      expectedAnnualRoi: params.expectedAnnualRoi,
      pendingCityCapexThisMonth: cityCapex,
      pendingPrivateCapexThisMonth: marketFavorable ? privateCapex : 0n,
    };
    reg.factories.push(project);
    return project;
  }

  /**
   * Municipal 100% Buyout Backstop (GDD §3.1): when private investors decline the 90% share,
   * City Hall pays the remaining 90% from its own budget, acquiring 100% of the plant's equity.
   */
  public mayorBuyoutStalledFactory(
    sectorId: SectorId,
    projectId: string,
    fullBuildCostLocal: Money
  ): FactoryEquityProject {
    const reg = this.getRegion(sectorId);
    const proj = reg.factories.find((f) => f.projectId === projectId);
    if (!proj) throw new Error(`Factory project ${projectId} not found in sector ${sectorId}`);
    if (proj.status === "operational") return proj;

    const remaining = fullBuildCostLocal - proj.totalCapexCommitted;
    if (remaining > 0n) {
      proj.pendingCityCapexThisMonth += remaining;
      proj.totalCapexCommitted = fullBuildCostLocal;
    }
    proj.cityShare = 1.0;
    proj.privateShare = 0.0;
    proj.status = "operational";
    return proj;
  }

  /**
   * Upgrades an operational factory (Lv.2–5). If `mayorPaysAll` is true (or private market
   * refuses), Treasury funds 100% of the upgrade and dilutes the private equity stake
   * proportionally to cumulative invested capital (GDD §3.1).
   */
  public upgradeFactoryProject(params: {
    sectorId: SectorId;
    projectId: string;
    upgradeCostLocal: Money;
    mayorPaysAll?: boolean;
  }): FactoryEquityProject {
    const reg = this.getRegion(params.sectorId);
    const proj = reg.factories.find((f) => f.projectId === params.projectId);
    if (!proj) throw new Error(`Factory project ${params.projectId} not found`);
    if (proj.level >= 5) throw new RangeError("Factory already at max Level 5");

    const loanRate = Math.max(
      0.01,
      reg.levers.keyRate + 0.03 - reg.levers.creditSubsidyRate
    );
    const privateWilling =
      !params.mayorPaysAll && proj.privateShare > 0 && proj.expectedAnnualRoi > loanRate;

    const prevCityCapital = mulRate(proj.totalCapexCommitted, proj.cityShare);
    let addCity: Money;
    let addPrivate: Money;

    if (privateWilling) {
      addCity = mulRate(params.upgradeCostLocal, proj.cityShare);
      addPrivate = params.upgradeCostLocal - addCity;
    } else {
      addCity = params.upgradeCostLocal;
      addPrivate = 0n;
    }

    const newTotal = proj.totalCapexCommitted + params.upgradeCostLocal;
    const newCityCapital = prevCityCapital + addCity;
    proj.totalCapexCommitted = newTotal;
    proj.cityShare =
      newTotal > 0n ? Math.min(1, Math.max(0, toUnits(newCityCapital) / toUnits(newTotal))) : 1;
    proj.privateShare = Math.max(0, 1 - proj.cityShare);
    proj.pendingCityCapexThisMonth += addCity;
    proj.pendingPrivateCapexThisMonth += addPrivate;
    proj.level += 1;
    return proj;
  }

  /**
   * Schedules a hostile border/transit action if required by the Notice Window rule
   * (GDD §1.4: tariffs > 50%, embargoes, or gas shutoffs wait 3–6 game days).
   */
  public setImportDutyWithNotice(
    sectorId: SectorId,
    newDutyRate: number,
    target: SectorId | "outer_world" = "outer_world",
    noticeDays = 4
  ): { appliedImmediately: boolean; notice?: PendingHostileNotice } {
    const reg = this.getRegion(sectorId);
    const clamped = Math.max(0, Math.min(1.0, newDutyRate));
    if (clamped <= 0.50) {
      reg.levers.importDutyRate = clamped;
      return { appliedImmediately: true };
    }
    const delay = Math.max(3, Math.min(6, Math.round(noticeDays)));
    const notice: PendingHostileNotice = {
      id: `notice-${this.month}-${this.currentGameDay}-${this.pendingNotices.length + 1}`,
      sourceSector: sectorId,
      targetSector: target,
      actionType: "import_tariff_hike",
      proposedValue: clamped,
      activatesAtGameDay: this.currentGameDay + delay,
      descriptionRu: `Сектор ${sectorId} вводит заградительную пошлину ${Math.round(clamped * 100)}% (вступает в силу через ${delay} игр. дн.)`,
    };
    this.pendingNotices.push(notice);
    return { appliedImmediately: false, notice };
  }

  public addResourceConcession(contract: ResourceConcessionContract): void {
    this.concessions.push({ ...contract });
  }

  /**
   * Appends (or merges by label) a custom 7-column `[HH, Fc, Fk, T, Banks, CB, World]` double-entry
   * row into `sectorId`'s monthly ledger. Enforces `SUM(row) === 0n` and `CB === 0n` on the spot so
   * no operation can ever introduce a single minor-unit discrepancy.
   */
  public bookLedgerEntry(sectorId: SectorId, row: LedgerMatrixRow): void {
    const sum = row[1] + row[2] + row[3] + row[4] + row[5] + row[6] + row[7];
    if (sum !== 0n) {
      throw new Error(
        `Ledger row "${row[0]}" in Sector ${sectorId} violates SUM(row) == 0n (got ${sum})`
      );
    }
    if (row[6] !== 0n) {
      throw new Error(
        `Custom current/capital row "${row[0]}" cannot write directly to CB column (got ${row[6]})`
      );
    }
    if (
      row[1] === 0n &&
      row[2] === 0n &&
      row[3] === 0n &&
      row[4] === 0n &&
      row[5] === 0n &&
      row[7] === 0n
    ) {
      return;
    }
    const reg = this.getRegion(sectorId);
    const existingIdx = reg.pendingCustomRows.findIndex((r) => r[0] === row[0]);
    if (existingIdx >= 0) {
      const prev = reg.pendingCustomRows[existingIdx]!;
      reg.pendingCustomRows[existingIdx] = [
        row[0],
        prev[1] + row[1],
        prev[2] + row[2],
        prev[3] + row[3],
        prev[4] + row[4],
        prev[5] + row[5],
        0n,
        prev[7] + row[7],
      ];
    } else {
      reg.pendingCustomRows.push([...row]);
    }
  }

  /**
   * Eminent Domain 100% compensation when demolishing occupied residential housing (`T -> HH`):
   * row `[+comp, 0n, 0n, -comp, 0n, 0n, 0n]`, `SUM(row) == 0n`.
   */
  public bookEminentDomainBuyout(
    sectorId: SectorId,
    compensationLocal: Money,
    recipient: "HH" | "Fk" = "HH"
  ): void {
    if (compensationLocal <= 0n) return;
    if (recipient === "HH") {
      this.bookLedgerEntry(sectorId, [
        "Eminent domain buyout (demolition)",
        compensationLocal,
        0n,
        0n,
        -compensationLocal,
        0n,
        0n,
        0n,
      ]);
    } else {
      this.bookLedgerEntry(sectorId, [
        "Commercial eminent domain buyout",
        0n,
        0n,
        compensationLocal,
        -compensationLocal,
        0n,
        0n,
        0n,
      ]);
    }
  }

  /**
   * Books private developers' construction material imports (`Fk -> World`) and customs duties (`Fk -> T`).
   */
  public bookDeveloperMaterialImport(
    sectorId: SectorId,
    importSupplierCostLocal: Money,
    customsDutyLocal: Money
  ): void {
    if (importSupplierCostLocal > 0n) {
      this.bookLedgerEntry(sectorId, [
        "Developer imported materials (Fk -> World)",
        0n,
        0n,
        -importSupplierCostLocal,
        0n,
        0n,
        0n,
        importSupplierCostLocal,
      ]);
    }
    if (customsDutyLocal > 0n) {
      this.bookLedgerEntry(sectorId, [
        "Developer material customs (Fk -> T)",
        0n,
        0n,
        -customsDutyLocal,
        customsDutyLocal,
        0n,
        0n,
        0n,
      ]);
    }
  }

  /**
   * Books 5-stage personal auto lifecycle flows (`HH -> Fc` local dealership/used/STO, `HH -> World` imported cars).
   */
  public bookAutoMarketFlows(params: {
    sectorId: SectorId;
    localAutoAndStoSpend: Money;
    importedAutoSpend: Money;
    scrapSteelCredit: Money;
  }): void {
    const { sectorId, localAutoAndStoSpend, importedAutoSpend, scrapSteelCredit } = params;
    if (localAutoAndStoSpend > 0n) {
      this.bookLedgerEntry(sectorId, [
        "Auto dealerships, used lots & STO repairs",
        -localAutoAndStoSpend,
        localAutoAndStoSpend,
        0n,
        0n,
        0n,
        0n,
        0n,
      ]);
    }
    if (importedAutoSpend > 0n) {
      this.bookLedgerEntry(sectorId, [
        "Imported passenger cars (HH -> World)",
        -importedAutoSpend,
        0n,
        0n,
        0n,
        0n,
        0n,
        importedAutoSpend,
      ]);
    }
    if (scrapSteelCredit > 0n) {
      this.bookLedgerEntry(sectorId, [
        "Auto scrapyard steel recycling",
        scrapSteelCredit,
        -scrapSteelCredit,
        0n,
        0n,
        0n,
        0n,
        0n,
      ]);
    }
  }

  /**
   * Evaluates 48-hour AFK mayor timeout and activates/releases conservative AI Caretaker
   * Governor (`GDD §1.2`: Taylor rule, 6% import tariff, zero money printing).
   */
  public evaluateAiGovernorTimeouts(nowEpochMs: number): SectorId[] {
    const afkMs = 48 * 3600 * 1000;
    const switched: SectorId[] = [];
    for (const reg of this.regions.values()) {
      if (reg.mayorUid && !reg.isAiGovernor && nowEpochMs - reg.lastMayorActivityEpochMs >= afkMs) {
        reg.isAiGovernor = true;
        reg.levers.useTaylorAdvisor = true;
        reg.levers.cbBondPurchaseShare = 0;
        reg.levers.importDutyRate = 0.06;
        switched.push(reg.sectorId);
      }
    }
    return switched;
  }

  public advanceGameDays(days: number): PendingHostileNotice[] {
    this.currentGameDay += days;
    const activated: PendingHostileNotice[] = [];
    for (let i = this.pendingNotices.length - 1; i >= 0; i--) {
      const n = this.pendingNotices[i]!;
      if (this.currentGameDay >= n.activatesAtGameDay) {
        if (n.actionType === "import_tariff_hike") {
          this.getRegion(n.sourceSector).levers.importDutyRate = n.proposedValue;
        }
        activated.push(n);
        this.pendingNotices.splice(i, 1);
      }
    }
    return activated;
  }

  /**
   * Advances the entire 5-region peninsula by 1 economic month (= 30 game days = 1 citizen life year),
   * builds each region's 7-column `BigInt` flow matrix, asserts all 4 double-entry invariants,
   * updates stocks, floating FX rates, inflation, Taylor-rule / IMF policies, and inter-regional migration.
   */
  public stepMonth(): RegionMonthlyReport[] {
    const t = this.month;
    this.month += 1;
    this.advanceGameDays(30);

    const worldCycle = 1 + 0.15 * Math.sin((2 * Math.PI * t) / 24);
    const reports: RegionMonthlyReport[] = [];

    for (const sectorId of [1, 2, 3, 4, 5] as const) {
      const reg = this.getRegion(sectorId);
      const report = this.stepSingleRegion(reg, t, worldCycle);
      reg.lastReport = report;
      reports.push(report);
    }

    // Inter-regional household migration based on Happiness H & FX-adjusted real wages (GDD §6.7)
    this.applyInterRegionalMigration();

    // Decrement active resource concession durations
    for (let i = this.concessions.length - 1; i >= 0; i--) {
      this.concessions[i]!.monthsRemaining -= 1;
      if (this.concessions[i]!.monthsRemaining <= 0) {
        this.concessions.splice(i, 1);
      }
    }

    return reports;
  }

  private stepSingleRegion(
    reg: RegionEconomyState,
    t: number,
    worldCycle: number
  ): RegionMonthlyReport {
    const P = reg.cpi;
    const fx = reg.fxRatePerWcu;
    const sh = reg.baseShares;

    // Enforce IMF conditionality if programme is active (GDD §3.2 & Sheet 08 Section 2)
    const lastAnnInflation =
      (reg.inflationHistory[reg.inflationHistory.length - 1] ?? 0.0025) * 12;
    if (reg.imf.active) {
      reg.levers.cbBondPurchaseShare = 0;
      reg.levers.keyRate = Math.max(reg.levers.keyRate, Math.max(0.01, lastAnnInflation + 0.02));
      reg.levers.pensionIndexationEnabled = false;
    }

    const effectiveVat = Math.min(0.25, reg.levers.vatRate + (reg.imf.active ? 0.02 : 0));
    const effectivePubMult = reg.levers.publicSpendingMultiplier * (reg.imf.active ? 0.95 : 1.0);

    const keyRate = reg.levers.keyRate;
    const { rating, spread } = computeCreditRating(reg.debtToRevenueRatio);
    const rDep = Math.max(0.005, keyRate - 0.03);
    const firmRiskSpread = Math.min(0.06, 0.005 + reg.hardshipShare * 0.12);
    const rFirmMarket = keyRate + 0.03 + firmRiskSpread;
    const rFirmEffective = Math.max(0.01, rFirmMarket - reg.levers.creditSubsidyRate);
    const rMort = keyRate + 0.01;
    const rBond = keyRate + spread;

    // ---- 1. Households (in exact BigInt minor units)
    const popNow = reg.classes.reduce((a, c) => a + c.households, 0);
    const workingPop =
      reg.classes[0]!.households + reg.classes[1]!.households + reg.classes[2]!.households;
    const hardWeights = [1, 0.5, 0.25, 0] as const;

    const classWages: Money[] = reg.classes.map((c, i) =>
      money(c.households * c.wageUnits * P * (1 - reg.hardshipShare * hardWeights[i]!))
    );
    const classBenefits: Money[] = reg.classes.map((c, i) =>
      money(
        c.households *
          c.wageUnits *
          P *
          reg.hardshipShare *
          hardWeights[i]! *
          reg.levers.unemploymentBenefitRate
      )
    );
    const W = classWages.reduce((a, b) => a + b, 0n);
    const [Wf, Wt, Wb] = allocate(W, [
      PENINSULA_BASE.wageFirmsShare,
      PENINSULA_BASE.wagePublicShare,
      PENINSULA_BASE.wageBanksShare,
    ]) as [Money, Money, Money];

    const classPensions: Money[] = reg.classes.map(
      (c, i) => money(c.households * c.pensionUnits * P) + classBenefits[i]!
    );
    const PENS = classPensions.reduce((a, b) => a + b, 0n);

    const depWeights = reg.classes.map((c) => Math.max(0, toUnits(c.deposits)));
    const depInt = mulRate(reg.householdDeposits, rDep / 12);
    const classDepInt = allocate(depInt, depWeights);

    const classHousingPay: Money[] = reg.classes.map((c) =>
      money(c.households * c.housingUnits * P * reg.rentIndex)
    );
    const totalHousingPay = classHousingPay.reduce((a, b) => a + b, 0n);
    const mortInt = mulRate(reg.mortgages, rMort / 12);
    const rent = totalHousingPay > mortInt ? totalHousingPay - mortInt : 0n;
    const actualMortInt = totalHousingPay - rent; // guarantees housingPay === rent + actualMortInt

    const classWealthSpend: Money[] = reg.classes.map((c) =>
      c.deposits > 0n ? mulRate(c.deposits, PENINSULA_BASE.wealthSpendMonthlyShare) : 0n
    );
    const classCons: Money[] = reg.classes.map(
      (c, i) =>
        money(
          c.households *
            (c.foodUnits +
              c.goodsUnits +
              c.utilitiesUnits +
              c.transportUnits +
              c.leisureUnits * (reg.levers.activeDecreeIds.includes("NIGHT_CURFEW") ? 0.95 : 1.0)) *
            P
        ) + classWealthSpend[i]!
    );
    const C = classCons.reduce((a, b) => a + b, 0n);

    const fireMult = reg.levers.activeDecreeIds.includes("FIRE_CODE") ? 0.80 : 1.0;
    const classPremiums: Money[] = reg.classes.map((c) =>
      money(c.households * c.insuranceUnits * P * fireMult)
    );
    const PREM = classPremiums.reduce((a, b) => a + b, 0n);
    const CLAIMS = mulRate(PREM, PENINSULA_BASE.insuranceLossRatio);
    const classClaims = allocate(
      CLAIMS,
      classPremiums.map((p) => toUnits(p))
    );

    const classPropTax: Money[] = reg.classes.map((c) =>
      money(c.households * c.propertyTaxUnits * P)
    );
    const PT = classPropTax.reduce((a, b) => a + b, 0n);

    const classPit: Money[] = reg.classes.map((c, i) => mulRate(classWages[i]!, c.pitRate));
    const PIT = classPit.reduce((a, b) => a + b, 0n);

    // ---- 2. External Trade (Outer World + 4 Neighbours), converted via floating fxRate
    const realExchangeCompetitiveness = Math.max(0.65, Math.min(1.45, fx / P));
    const popScalePeninsula = popNow / 275_000;
    const consRatioToRegionBase =
      popNow > 0 ? toUnits(C) / Math.max(1, 547_925_000 * popScalePeninsula * P) : 1;

    const exportsWcuUnits =
      (PENINSULA_BASE.outerExportsWcu * sh.outerExportShare +
        PENINSULA_BASE.interPlayerTradeWcu * sh.interPlayerSalesShare) *
      worldCycle *
      Math.pow(realExchangeCompetitiveness, 0.45);
    const importsWcuUnits =
      (PENINSULA_BASE.outerImportsWcu * sh.outerImportShare +
        PENINSULA_BASE.interPlayerTradeWcu * sh.interPlayerPurchasesShare) *
      Math.max(0.4, Math.min(1.8, consRatioToRegionBase)) *
      Math.pow(1 / realExchangeCompetitiveness, 0.25);

    const X = money(exportsWcuUnits * fx);
    const M = money(importsWcuUnits * fx);
    const tour = money(
      PENINSULA_BASE.tourismWcu *
        sh.tourismShare *
        fx *
        Math.pow(realExchangeCompetitiveness, 0.3)
    );
    const visa = money(PENINSULA_BASE.visaWcu * sh.tourismShare * fx);
    const migrantSavings = money(PENINSULA_BASE.migrantSavingsWcu * sh.householdsShare * fx);

    // Resource concessions (15% royalty between operator firm and landowner treasury)
    let royaltyPaidOut = 0n;
    let royaltyReceivedIn = 0n;
    for (const c of this.concessions) {
      const valWcu = c.monthlyExtractedValueWcu * c.royaltyRate;
      if (c.operatorSector === reg.sectorId) {
        royaltyPaidOut += money(valWcu * fx);
      }
      if (c.landownerSector === reg.sectorId) {
        royaltyReceivedIn += money(valWcu * fx);
      }
    }

    // ---- 3. Bank Capital & Credit Supply Willingness (Sheet 08 Section 1)
    const totalLoansStart = reg.firmLoans + reg.mortgages;
    const startCapRatio =
      totalLoansStart > 0n ? toUnits(reg.bankCapital) / toUnits(totalLoansStart) : 0.13;
    const bankWillingness =
      startCapRatio >= PENINSULA_BASE.fullLendingCapitalRatio
        ? 1.0
        : startCapRatio <= PENINSULA_BASE.minBankCapitalRatio
          ? 0.0
          : (startCapRatio - PENINSULA_BASE.minBankCapitalRatio) /
            (PENINSULA_BASE.fullLendingCapitalRatio - PENINSULA_BASE.minBankCapitalRatio);

    // Each +1 pp on business loan rate above 10% cuts credit demand by 8% (GDD §3.2)
    const creditDemandFactor = Math.max(0.05, Math.min(1.6, 1 - (rFirmEffective - 0.10) * 8));
    const newBusinessCreditIndex = bankWillingness * creditDemandFactor;

    // ---- 4. Government, Investment & 10%/90% Co-Investment Projects
    const G = money(
      (PENINSULA_BASE.govContracts + PENINSULA_BASE.govPrograms) *
        P *
        popScalePeninsula *
        effectivePubMult
    );
    const creditSubsidyCost = mulRate(reg.firmLoans, reg.levers.creditSubsidyRate / 12);
    const subs =
      money(PENINSULA_BASE.subsidies * P * popScalePeninsula * effectivePubMult) +
      creditSubsidyCost;
    const emin = money(PENINSULA_BASE.eminentDomain * P * sh.householdsShare);

    let cityEquityCapex = 0n;
    let privateEquityCapex = 0n;
    for (const proj of reg.factories) {
      cityEquityCapex += proj.pendingCityCapexThisMonth;
      privateEquityCapex += proj.pendingPrivateCapexThisMonth;
      proj.pendingCityCapexThisMonth = 0n;
      proj.pendingPrivateCapexThisMonth = 0n;
    }

    const baseCapexIndex = Math.max(
      0,
      Math.min(1.7, bankWillingness * (1 - (rFirmEffective - 0.10) * 5))
    );
    const capex =
      money(PENINSULA_BASE.capex * P * popScalePeninsula * baseCapexIndex) +
      cityEquityCapex +
      privateEquityCapex;

    const vacancy = popNow > 0 ? reg.dwellings / popNow - 1 : 0.03;
    const housingBoost = Math.min(4, Math.max(0.3, 1 + 12 * (0.03 - vacancy)));
    const newHousing = money(PENINSULA_BASE.newHousing * P * popScalePeninsula * housingBoost);
    const newMort = money(
      PENINSULA_BASE.newMortgages *
        P *
        popScalePeninsula *
        housingBoost *
        bankWillingness *
        Math.min(1.6, 0.08 / Math.max(0.02, rMort))
    );
    const dDf = money(PENINSULA_BASE.firmDepChange * P * popScalePeninsula);

    // Customs duties & contraband shadow leakage (GDD §5.3)
    const smugglingShare = computeSmugglingRate(reg.levers.importDutyRate);
    const legalShare = 1 - smugglingShare;
    const duties =
      mulRate(M, reg.levers.importDutyRate * legalShare) +
      mulRate(X, reg.levers.exportDutyRate);
    const evadedDuties = mulRate(M, reg.levers.importDutyRate * smugglingShare);
    const shadow = mulRate(evadedDuties, PENINSULA_BASE.shadowMarginShare);

    // ---- 5. Firms Current & Capital Account
    const frev = C + rent + newHousing + G + subs + X + tour + capex + PREM;
    const VAT = mulRate(C + newHousing, effectiveVat / (1 + effectiveVat));
    const lint = mulRate(reg.firmLoans, rFirmMarket / 12);

    const firmOutflowsBeforeProfit =
      Wf + M + VAT + duties + lint + royaltyPaidOut + shadow + CLAIMS;
    const pre = frev - firmOutflowsBeforeProfit;
    const ctax = pre > 0n ? mulRate(pre, reg.levers.corpTaxRate) : 0n;
    const after = pre - ctax;
    const div = after > 0n ? mulRate(after, PENINSULA_BASE.payoutRatio) : 0n;

    // Effective Treasury equity share: Contour B (28%) + weighted processing share (~7% at 10% seed)
    const activeFactories = reg.factories.filter((f) => f.status === "operational");
    const avgPlantCityShare =
      activeFactories.length > 0
        ? activeFactories.reduce((s, f) => s + f.cityShare, 0) / activeFactories.length
        : reg.levers.cityNewPlantShare;
    const stateEquityEffective = Math.min(
      1.0,
      PENINSULA_BASE.contourBStateShare + 0.70 * avgPlantCityShare
    );
    const customRows = reg.pendingCustomRows.splice(0);
    const extraFc = customRows.reduce((s, r) => s + r[2], 0n);
    const extraTrev = customRows.reduce((s, r) => (r[4] > 0n ? s + r[4] : s), 0n);
    const extraTexp = customRows.reduce((s, r) => (r[4] < 0n ? s - r[4] : s), 0n);

    const divT = mulRate(div, stateEquityEffective);
    const divH = div - divT;
    const retained = after - div + extraFc; // exact residual: ensures NL_Fc === 0n even with custom Fc rows!

    // ---- 6. Loan Defaults, Banks & Central Bank
    const mortDefAnnual =
      PENINSULA_BASE.mortDefaultAnnual *
      Math.max(0.3, reg.hardshipShare / 0.03) *
      (rMort / 0.08);
    const firmDefAnnual =
      PENINSULA_BASE.firmDefaultAnnual *
      Math.pow(rFirmEffective / 0.10, 1.5) *
      Math.max(0.5, 2 - worldCycle);

    const writeMort =
      reg.mortgages > 0n ? mulRate(reg.mortgages, Math.min(0.25, mortDefAnnual / 12)) : 0n;
    const writeFirm =
      reg.firmLoans > 0n ? mulRate(reg.firmLoans, Math.min(0.25, firmDefAnnual / 12)) : 0n;
    const WO = writeMort + writeFirm;

    const bintB = mulRate(reg.govBondsBanks, rBond / 12);
    const bintCB = mulRate(reg.govBondsCb, rBond / 12);
    const refiInt = mulRate(reg.cbRefinancing, keyRate / 12);

    const bankGross = lint + actualMortInt + bintB - depInt - Wb - refiInt;
    const bankDiv = bankGross > WO ? bankGross - WO : 0n;
    const bankLoss = WO > bankGross ? WO - bankGross : 0n;
    const cbProfit = refiInt + bintCB;

    // Bank recapitalisation: below 11% capital ratio, banks issue new equity to households (Sheet 08)
    const bankRecapShares =
      startCapRatio < PENINSULA_BASE.recapTriggerCapitalRatio && totalLoansStart > 0n
        ? mulRate(
            totalLoansStart,
            Math.min(0.005, PENINSULA_BASE.recapTriggerCapitalRatio - startCapRatio)
          )
        : 0n;

    // ---- 7. Sovereign Wealth Fund (SWF), IMF Facility & Treasury
    const dSwfLocal =
      reg.levers.swfSterilizationShare > 0
        ? mulRate(X, reg.levers.swfSterilizationShare * 0.15)
        : 0n;

    // Check IMF trigger & tranche schedule (GDD §3.2 & Sheet 08 Section 2)
    const monthlyImportsWcuVal = Math.max(1, importsWcuUnits);
    const fxMonths = toUnits(reg.fxReservesWcu) / monthlyImportsWcuVal;
    if (!reg.imf.active && (fxMonths < 2.0 || spread >= 0.05)) {
      reg.imf.active = true;
      const annualWagesWcu = (toUnits(W) * 12) / fx;
      reg.imf.totalApprovedWcu = money(annualWagesWcu * 0.25);
      reg.imf.tranchesDisbursed = 0;
      reg.imf.monthsSinceActivation = 0;
    }

    let dImfWcu = 0n;
    if (reg.imf.active) {
      if (
        reg.imf.tranchesDisbursed < 4 &&
        reg.imf.monthsSinceActivation % 3 === 0
      ) {
        const tranche = reg.imf.totalApprovedWcu / 4n;
        dImfWcu += tranche;
        reg.imf.tranchesDisbursed += 1;
      }
      if (reg.imf.monthsSinceActivation >= 12 && reg.imf.debtPrincipalWcu > 0n) {
        const repay = reg.imf.totalApprovedWcu / 24n;
        const actualRepay = repay < reg.imf.debtPrincipalWcu ? repay : reg.imf.debtPrincipalWcu;
        dImfWcu -= actualRepay;
      }
      reg.imf.monthsSinceActivation += 1;
    }
    const imfInterestWcu =
      reg.imf.debtPrincipalWcu > 0n ? mulRate(reg.imf.debtPrincipalWcu, 0.04 / 12) : 0n;
    const imfInterestLocal = money(toUnits(imfInterestWcu) * fx);
    const dImfLocal = money(toUnits(dImfWcu) * fx);

    const trev =
      PIT + PT + VAT + ctax + duties + visa + divT + cbProfit + royaltyReceivedIn + extraTrev;
    const texp =
      Wt + G + PENS + subs + bintB + bintCB + emin + cityEquityCapex + imfInterestLocal + extraTexp;

    // ---- 8. Assemble Current & Capital Account Matrix Rows
    // Every row is constructed so sum(row) === 0n identically!
    const currentAndCapRows: LedgerMatrixRow[] = [
      ["Consumption", -C, C, 0n, 0n, 0n, 0n, 0n],
      ["Rent", -rent, rent, 0n, 0n, 0n, 0n, 0n],
      ["New housing", -newHousing, newHousing, 0n, 0n, 0n, 0n, 0n],
      ["Government purchases", 0n, G, 0n, -G, 0n, 0n, 0n],
      ["Subsidies", 0n, subs, 0n, -subs, 0n, 0n, 0n],
      ["Investment goods (capex)", 0n, capex, -capex, 0n, 0n, 0n, 0n],
      ["Factory equity: municipal (10%/buyout)", 0n, 0n, cityEquityCapex, -cityEquityCapex, 0n, 0n, 0n],
      ["Factory equity: private (90%)", -privateEquityCapex, 0n, privateEquityCapex, 0n, 0n, 0n, 0n],
      ["Exports", 0n, X, 0n, 0n, 0n, 0n, -X],
      ["Tourism", 0n, tour, 0n, 0n, 0n, 0n, -tour],
      ["Imports", 0n, -M, 0n, 0n, 0n, 0n, M],
      ["Wages", W, -Wf, 0n, -Wt, -Wb, 0n, 0n],
      ["Pensions & benefits", PENS, 0n, 0n, -PENS, 0n, 0n, 0n],
      ["Personal income tax (PIT)", -PIT, 0n, 0n, PIT, 0n, 0n, 0n],
      ["Property tax", -PT, 0n, 0n, PT, 0n, 0n, 0n],
      ["VAT", 0n, -VAT, 0n, VAT, 0n, 0n, 0n],
      ["Customs duties", 0n, -duties, 0n, duties, 0n, 0n, 0n],
      ["Visa & tourist fees", 0n, 0n, 0n, visa, 0n, 0n, -visa],
      ["Corporate profit tax", 0n, -ctax, 0n, ctax, 0n, 0n, 0n],
      ["Dividends", divH + bankDiv, -div, 0n, divT, -bankDiv, 0n, 0n],
      ["Deposit interest", depInt, 0n, 0n, 0n, -depInt, 0n, 0n],
      ["Mortgage interest", -actualMortInt, 0n, 0n, 0n, actualMortInt, 0n, 0n],
      ["Firm loan interest", 0n, -lint, 0n, 0n, lint, 0n, 0n],
      ["Government bond interest", 0n, 0n, 0n, -(bintB + bintCB), bintB, bintCB, 0n],
      ["CB refinancing interest", 0n, 0n, 0n, 0n, -refiInt, refiInt, 0n],
      ["CB profit transfer", 0n, 0n, 0n, cbProfit, 0n, -cbProfit, 0n],
      ["IMF facility interest", 0n, 0n, 0n, -imfInterestLocal, 0n, 0n, imfInterestLocal],
      ["Insurance premiums", -PREM, PREM, 0n, 0n, 0n, 0n, 0n],
      ["Insurance claims", CLAIMS, -CLAIMS, 0n, 0n, 0n, 0n, 0n],
      [
        "Resource concession royalties",
        0n,
        -royaltyPaidOut,
        0n,
        royaltyReceivedIn,
        0n,
        0n,
        royaltyPaidOut - royaltyReceivedIn,
      ],
      ["Contraband shadow margin", shadow, -shadow, 0n, 0n, 0n, 0n, 0n],
      ["Retained profits", 0n, -retained, retained, 0n, 0n, 0n, 0n],
      ["Migrant savings", migrantSavings, 0n, 0n, 0n, 0n, 0n, -migrantSavings],
      ["Eminent domain compensation", emin, 0n, 0n, -emin, 0n, 0n, 0n],
      ...customRows,
    ];

    // Net lending per column before financial account: [HH, Fc, Fk, T, Banks, CB, World]
    const NL = MATRIX_COLUMNS.map((_, colIdx) =>
      currentAndCapRows.reduce((acc, r) => acc + (r[colIdx + 1] as Money), 0n)
    ) as [Money, Money, Money, Money, Money, Money, Money];

    const nlHH = NL[0];
    const nlFk = NL[2];
    const nlT = NL[3];
    const nlBanks = NL[4];
    const nlWorld = NL[6];

    // ---- 9. Financial Account (`Δ` Stocks)
    const dDh = nlHH + newMort - bankRecapShares;
    const dLf = -nlFk + dDf;
    const dTreasuryCash = 0n;
    const dB = -(nlT + dImfLocal - dSwfLocal) + dTreasuryCash;

    const cbBondShareEffective = reg.imf.active ? 0 : reg.levers.cbBondPurchaseShare;
    const dBCb = dB > 0n ? mulRate(dB, cbBondShareEffective) : 0n;
    const dBBanks = dB - dBCb;

    // Reserve requirement & CB refinancing check (Sheet 08 Section 1)
    const depositsEnd = reg.householdDeposits + dDh + reg.firmDeposits + dDf;
    const loansEnd = reg.firmLoans + dLf - writeFirm + reg.mortgages + newMort - writeMort;
    const ltdLimit = (1.25 * (1 - reg.levers.reserveRequirement)) / 0.95;
    const maxUnrefinancedLoans = depositsEnd > 0n ? mulRate(depositsEnd, ltdLimit) : 0n;
    const targetRefi = loansEnd > maxUnrefinancedLoans ? loansEnd - maxUnrefinancedLoans : 0n;
    const dRefi = targetRefi - reg.cbRefinancing;

    // Bank reserves at the CB (`dR`) derived SOLELY from Commercial Banks' own balance!
    // The `CB` column is NEVER plugged — its convergence to `0n` is the independent Walras test.
    const dR =
      nlBanks + dDh + bankRecapShares + dDf - newMort - dLf - dBBanks + dRefi;

    const worldNetAfterImfSwf = nlWorld - dImfLocal + dSwfLocal;

    const financialRows: LedgerMatrixRow[] = [
      ["Δ household deposits", -dDh, 0n, 0n, 0n, dDh, 0n, 0n],
      ["Bank recapitalisation shares", -bankRecapShares, 0n, 0n, 0n, bankRecapShares, 0n, 0n],
      ["Δ firm deposits", 0n, 0n, -dDf, 0n, dDf, 0n, 0n],
      ["Δ mortgages", newMort, 0n, 0n, 0n, -newMort, 0n, 0n],
      ["Δ firm loans", 0n, 0n, dLf, 0n, -dLf, 0n, 0n],
      ["Δ IMF credit", 0n, 0n, 0n, dImfLocal, 0n, 0n, -dImfLocal],
      ["Δ Sovereign Wealth Fund (SWF)", 0n, 0n, 0n, -dSwfLocal, 0n, 0n, dSwfLocal],
      ["Δ government bonds", 0n, 0n, 0n, dB, -dBBanks, -dBCb, 0n],
      ["Δ CB refinancing", 0n, 0n, 0n, 0n, dRefi, -dRefi, 0n],
      ["Δ treasury account at CB", 0n, 0n, 0n, -dTreasuryCash, 0n, dTreasuryCash, 0n],
      ["Δ bank reserves at CB", 0n, 0n, 0n, 0n, -dR, dR, 0n],
      [
        "Δ FX reserves / Outer World account",
        0n,
        0n,
        0n,
        0n,
        0n,
        worldNetAfterImfSwf,
        -worldNetAfterImfSwf,
      ],
    ];

    const fullMatrix: LedgerMatrixRow[] = [...currentAndCapRows, ...financialRows];
    const invariants = verifyLedgerInvariants(fullMatrix, {
      dDh,
      dDf,
      newMort,
      dLf,
      dBBanks,
      nlBanks,
      bankRecapShares,
      dBCb,
      dTreasuryCash,
      worldNetAfterImfSwf,
    });
    if (!invariants.valid) {
      throw new Error(
        `Double-entry invariant violation in Sector ${reg.sectorId} month ${t + 1}: ` +
          `rowErr=${invariants.maxRowError}, colErr=${invariants.maxColError}, ` +
          `cbSum=${invariants.cbColumnIndependentSum}, moneyDiff=${invariants.moneyDecompositionDiff}`
      );
    }

    // ---- 10. Per-Class Savings & Stock Updates
    const divPool = divH + bankDiv;
    const divShares = reg.classes.map((c) => c.dividendShare);
    const classDivs = allocate(divPool, divShares);

    const classSavings: Money[] = reg.classes.map((_, i) => {
      const inc = classWages[i]! + classPensions[i]! + classDivs[i]! + classDepInt[i]!;
      const out =
        classPit[i]! +
        classPropTax[i]! +
        classHousingPay[i]! +
        classCons[i]! +
        classPremiums[i]! -
        classClaims[i]!;
      return inc - out;
    });
    const sumClassSavings = classSavings.reduce((a, b) => a + b, 0n);
    const nonClassDelta = dDh - sumClassSavings;
    const nonClassAlloc = allocate(nonClassDelta, depWeights);

    reg.classes.forEach((c, i) => {
      c.deposits += classSavings[i]! + nonClassAlloc[i]!;
    });

    const prevMoneyStock = reg.householdDeposits + reg.firmDeposits;
    const moneyGrowth =
      prevMoneyStock > 0n ? toUnits(dDh + dDf) / toUnits(prevMoneyStock) : 0;

    reg.householdDeposits += dDh;
    reg.firmDeposits += dDf;
    reg.firmLoans = reg.firmLoans + dLf - writeFirm;
    reg.mortgages = reg.mortgages + newMort - writeMort;
    reg.govBondsBanks += dBBanks;
    reg.govBondsCb += dBCb;
    reg.cbRefinancing += dRefi;
    reg.bankCapital = reg.bankCapital - bankLoss + bankRecapShares;
    reg.treasuryCashAtCb += dTreasuryCash;

    // External WCU stocks & floating FX rate update (GDD §3.2 & Sheet 08)
    const bopInflowLocal = -worldNetAfterImfSwf; // > 0 when region runs external surplus
    const bopInflowWcuUnits = toUnits(bopInflowLocal) / fx;
    const interventionShare = reg.imf.active
      ? Math.min(0.15, reg.levers.fxInterventionShare)
      : reg.levers.fxInterventionShare;

    let absorbedByReservesWcu = bopInflowWcuUnits * interventionShare;
    const currentReservesUnits = toUnits(reg.fxReservesWcu);
    if (absorbedByReservesWcu < 0 && -absorbedByReservesWcu > currentReservesUnits * 0.25) {
      absorbedByReservesWcu = -currentReservesUnits * 0.25;
    }
    reg.fxReservesWcu = money(Math.max(0, currentReservesUnits + absorbedByReservesWcu));
    reg.swfBalanceWcu += money(toUnits(dSwfLocal) / fx);
    reg.imf.debtPrincipalWcu += dImfWcu;
    if (
      reg.imf.active &&
      reg.imf.tranchesDisbursed >= 4 &&
      reg.imf.debtPrincipalWcu <= 0n
    ) {
      reg.imf.active = false;
      reg.imf.debtPrincipalWcu = 0n;
    }

    const unabsorbedBopWcu = bopInflowWcuUnits - absorbedByReservesWcu;
    const tradeScaleWcu = Math.max(1, exportsWcuUnits + importsWcuUnits);
    const bopPressure = unabsorbedBopWcu / tradeScaleWcu;

    const totalGovDebt = reg.govBondsBanks + reg.govBondsCb;
    const annualRevenueUnits = Math.max(1, toUnits(trev) * 12);
    reg.debtToRevenueRatio = toUnits(totalGovDebt) / annualRevenueUnits;
    reg.dwellings += toUnits(newHousing) / (PENINSULA_BASE.baseDwellingPrice * P);

    // ---- 11. Prices, Inflation, Floating FX & Taylor Rule
    const prevPop = reg.lastReport?.households ?? popNow;
    const realGrowth = popNow > 0 ? (popNow - prevPop) / popNow : 0;
    const cbMonetisationPush =
      trev > 0n && dBCb > 0n ? 0.04 * (toUnits(dBCb) / toUnits(trev)) : 0;
    const monthlyInfl = Math.max(
      -0.012,
      Math.min(
        0.035,
        0.0025 +
          0.30 * (moneyGrowth - realGrowth - 0.0025) +
          cbMonetisationPush +
          0.02 * (worldCycle - 1) * (C > 0n ? toUnits(M) / toUnits(C) : 0.4)
      )
    );
    reg.inflationHistory.push(monthlyInfl);
    if (reg.inflationHistory.length > 12) reg.inflationHistory.shift();

    reg.cpi *= 1 + monthlyInfl;
    reg.rentIndex *= 1 + Math.min(0.02, Math.max(-0.02, 0.5 * (0.03 - vacancy)));
    reg.classes.forEach((c) => {
      c.wageUnits *= 1 + monthlyInfl * 0.92;
      if (reg.levers.pensionIndexationEnabled) {
        c.pensionUnits *= 1 + monthlyInfl * 0.80;
      }
    });

    // Purchasing-power-parity + BoP + interest-rate differential FX dynamics
    const worldMonthlyInfl = 0.03 / 12;
    const rateDiff = keyRate - 0.07;
    const fxDelta = Math.max(
      -0.04,
      Math.min(
        0.06,
        (monthlyInfl - worldMonthlyInfl) * 0.85 - bopPressure * 0.12 - rateDiff * 0.06
      )
    );
    reg.fxRatePerWcu = Math.max(0.25, Math.min(5.0, reg.fxRatePerWcu * (1 + fxDelta)));

    const emaAnnualInfl =
      (reg.inflationHistory.slice(-3).reduce((a, b) => a + b, 0) /
        Math.min(3, reg.inflationHistory.length)) *
      12;

    if (reg.levers.useTaylorAdvisor && !reg.imf.active) {
      const taylorTarget = Math.min(0.25, Math.max(0.01, 0.07 + 1.5 * (emaAnnualInfl - 0.03)));
      reg.levers.keyRate += Math.max(-0.015, Math.min(0.015, taylorTarget - reg.levers.keyRate));
    }

    // ---- 12. Life-Clock Demography, Hardship & Happiness H (GDD §1.4, §6.2, §6.7)
    const retireAgeFactor = Math.max(
      0.6,
      1 - (reg.levers.retirementAge - 65) * 0.04
    );
    const effectiveRetireRate = DEMO_RATES.baseRetireRateAt65 * retireAgeFactor;
    const birthDecreeMult = reg.levers.activeDecreeIds.includes("YOUNG_FAMILY") ? 1.30 : 1.0;
    const gamblingMult = reg.levers.activeDecreeIds.includes("NIGHT_CURFEW") ? 0.50 : 1.0;

    const workClasses = [reg.classes[0]!, reg.classes[1]!, reg.classes[2]!] as const;
    const retiring = workClasses.map((c) => c.households * effectiveRetireRate);
    const entrants = workingPop * DEMO_RATES.naturalEntryRate * birthDecreeMult;

    const inflowHard =
      workingPop *
      (DEMO_RATES.jobLossMonthly * (1 + 3 * Math.max(0, 1 - worldCycle)) +
        DEMO_RATES.gamblingMonthly * gamblingMult +
        DEMO_RATES.idlenessMonthly +
        DEMO_RATES.lifeCrisisMonthly);
    const hardPool =
      reg.hardshipShare * workingPop +
      inflowHard -
      reg.hardshipShare * workingPop * DEMO_RATES.recoveryMonthly;
    reg.hardshipShare =
      workingPop > 0 ? Math.max(0, Math.min(0.35, hardPool / workingPop)) : 0;

    // Compute 11-factor Happiness H
    const workerClass = reg.classes[0]!;
    const workerFreeMoney =
      workerClass.households > 0
        ? (toUnits(classSavings[0]!) +
            workerClass.households * workerClass.leisureUnits * P +
            toUnits(classWealthSpend[0]!)) /
          workerClass.households
        : 0;
    const moneyScore = Math.min(
      100,
      Math.max(0, (workerFreeMoney / Math.max(1, workerClass.migrationFloorUnits * P)) * 50)
    );
    const jobsScore = Math.min(100, Math.max(0, ((0.20 - reg.hardshipShare) / 0.17) * 100));
    const housingScore = Math.min(100, Math.max(20, 75 + vacancy * 400 - (reg.rentIndex - 1) * 80));
    reg.happinessIndex = computeHappinessIndex({
      money: moneyScore,
      jobs: jobsScore,
      housing: housingScore,
      safety: reg.levers.activeDecreeIds.includes("NIGHT_CURFEW") ? 82 : 72 - smugglingShare * 40,
      health: reg.levers.activeDecreeIds.includes("GAS_SUBSIDY") ? 80 : 70,
      education: 72,
      environment: reg.levers.activeDecreeIds.includes("GAS_SUBSIDY") ? 82 : 68,
      transport: reg.levers.activeDecreeIds.includes("FREE_TRANSIT") ? 85 : 70,
      utilities: 85,
      leisure: 72,
      policy: Math.max(20, 85 - effectiveVat * 200),
    });

    workClasses.forEach((c, i) => {
      const freePerHh =
        c.households > 0
          ? (toUnits(classSavings[i]!) +
              c.households * c.leisureUnits * P +
              toUnits(classWealthSpend[i]!)) /
            c.households
          : 0;
      const gap =
        c.migrationFloorUnits > 0
          ? (freePerHh - c.migrationFloorUnits * P) / (c.migrationFloorUnits * P)
          : 0;
      let mig = Math.max(
        -DEMO_RATES.migrationCap,
        Math.min(DEMO_RATES.migrationCap, DEMO_RATES.migrationSensitivity * gap)
      );
      if (mig > 0) {
        mig *= Math.max(0, Math.min(1, (vacancy + 0.01) / 0.03));
        if (reg.happinessIndex < 35) mig = 0;
      }
      c.households = Math.max(
        10,
        c.households + entrants * DEMO_RATES.entryClassSplit[i]! - retiring[i]! + c.households * mig
      );
    });
    reg.classes[3]!.households = Math.max(
      5,
      reg.classes[3]!.households +
        retiring.reduce((a, b) => a + b, 0) -
        reg.classes[3]!.households * DEMO_RATES.retireeExitRate
    );

    const endLoans = reg.firmLoans + reg.mortgages;
    const endBankCapRatio =
      endLoans > 0n ? toUnits(reg.bankCapital) / toUnits(endLoans) : 0.13;
    const gdpLocal = C + newHousing + capex + G + X + tour - M;

    return {
      month: t + 1,
      sectorId: reg.sectorId,
      currency: reg.currency,
      fxRatePerWcu: reg.fxRatePerWcu,
      cpi: reg.cpi,
      annualInflation: emaAnnualInfl,
      keyRate: reg.levers.keyRate,
      businessLoanRate: rFirmEffective,
      mortgageRate: rMort,
      depositRate: rDep,
      bondYield: rBond,
      creditRating: rating,
      households: reg.classes.reduce((a, c) => a + c.households, 0),
      hardshipShare: reg.hardshipShare,
      happinessIndex: reg.happinessIndex,
      vacancyRate: vacancy,
      rentIndex: reg.rentIndex,
      gdpLocal,
      gdpWcu: toUnits(gdpLocal) / reg.fxRatePerWcu,
      treasuryRevenue: trev,
      treasuryExpenditure: texp,
      budgetBalance: trev - texp,
      govDebt: totalGovDebt,
      debtToAnnualRevenue: reg.debtToRevenueRatio,
      fxReservesWcu: reg.fxReservesWcu,
      fxReservesMonthsOfImports: toUnits(reg.fxReservesWcu) / monthlyImportsWcuVal,
      swfBalanceWcu: reg.swfBalanceWcu,
      imfActive: reg.imf.active,
      imfDebtWcu: reg.imf.debtPrincipalWcu,
      bankCapitalRatio: endBankCapRatio,
      bankWillingnessToLend: bankWillingness,
      newBusinessCreditIndex,
      businessInvestmentIndex: baseCapexIndex,
      stateEquityShareEffective: stateEquityEffective,
      smugglingLeakageShare: smugglingShare,
      matrix: fullMatrix,
      invariants,
    };
  }

  private applyInterRegionalMigration(): void {
    const regs = [...this.regions.values()];
    const scores = regs.map((r) => {
      const realWageWcu =
        (r.classes[0]!.wageUnits * r.cpi * (1 - r.classes[0]!.pitRate)) / r.fxRatePerWcu;
      return { r, composite: r.happinessIndex + realWageWcu / 150 };
    });
    scores.sort((a, b) => b.composite - a.composite);
    const best = scores[0]!;

    for (let k = 1; k < scores.length; k++) {
      const cur = scores[k]!;
      const gap = best.composite - cur.composite;
      if (gap > 10) {
        const moveRate = Math.min(0.005, ((gap - 10) / 40) * 0.005);
        for (let ci = 0; ci < 3; ci++) {
          const moved = cur.r.classes[ci]!.households * moveRate;
          cur.r.classes[ci]!.households -= moved;
          best.r.classes[ci]!.households += moved;
        }
      }
    }
  }
}

/**
 * Verifies the 4 iron double-entry accounting invariants of GDD §3.3 in exact `bigint` minor units.
 */
export function verifyLedgerInvariants(
  matrix: readonly LedgerMatrixRow[],
  decomp: {
    dDh: Money;
    dDf: Money;
    newMort: Money;
    dLf: Money;
    dBBanks: Money;
    nlBanks: Money;
    bankRecapShares: Money;
    dBCb: Money;
    dTreasuryCash: Money;
    worldNetAfterImfSwf: Money;
  }
): LedgerInvariantCheck {
  const rowErrors = matrix.map((row) => {
    let s = 0n;
    for (let c = 1; c <= 7; c++) s += row[c] as Money;
    return absBig(s);
  });
  const colSums = MATRIX_COLUMNS.map((_, colIdx) => {
    let s = 0n;
    for (const row of matrix) s += row[colIdx + 1] as Money;
    return s;
  });

  const maxRowError = maxBig(0n, ...rowErrors);
  const maxColError = maxBig(0n, ...colSums.map(absBig));
  const cbColumnIndependentSum = colSums[5] ?? 0n;

  // Invariant 4: Δ(Dh + Df) === netBankCredit + netCbMoneyCreation + netExternalInflow
  const broadMoneyChange = decomp.dDh + decomp.dDf;
  const netBankCredit =
    decomp.newMort +
    decomp.dLf +
    decomp.dBBanks -
    decomp.nlBanks -
    decomp.bankRecapShares;
  const netCbOps = decomp.dBCb - decomp.dTreasuryCash;
  const netExternal = -decomp.worldNetAfterImfSwf;
  const moneyDecompositionDiff = absBig(
    broadMoneyChange - (netBankCredit + netCbOps + netExternal)
  );

  return {
    valid:
      maxRowError === 0n &&
      maxColError === 0n &&
      cbColumnIndependentSum === 0n &&
      moneyDecompositionDiff === 0n,
    maxRowError,
    maxColError,
    cbColumnIndependentSum,
    moneyDecompositionDiff,
  };
}
