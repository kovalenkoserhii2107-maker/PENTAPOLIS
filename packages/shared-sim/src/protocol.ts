/**
 * Shared Multiplayer WebSocket & HTTP Protocol DTOs between `apps/server` and `apps/client`.
 *
 * `bigint` money fields are serialized as decimal minor-unit strings over JSON so zero
 * precision is ever lost in transit.
 */
import type { CurrencyCode } from "./money/currencies.ts";
import type { SectorId } from "./catalogs/visuals.ts";
import type { EmergencyId, HegemonyScoreBreakdown } from "./catalogs/sectorsAndLevers.ts";
import type { DualCalendarSnapshot } from "./catalogs/unitsAndTime.ts";
import type {
  CreditRating,
  MayorPolicyPreset,
  NetworkKind,
  ZoneKind,
} from "./index.ts";

export interface SerializedMatrixRow {
  readonly label: string;
  readonly cellsMinor: readonly [string, string, string, string, string, string, string];
}

export type StarterQuestStepId = 1 | 2 | 3 | 4;

export interface StarterQuestStepDto {
  readonly stepId: StarterQuestStepId;
  readonly titleRu: string;
  readonly descriptionRu: string;
  readonly rewardWcuUnits: number;
  readonly rewardLocalMinor: string;
  readonly completed: boolean;
  readonly claimed: boolean;
}

export interface SectorSummaryDto {
  readonly sectorId: SectorId;
  readonly occupied: boolean;
  readonly cityName: string;
  readonly mayorName: string;
  readonly isAiGovernor: boolean;
  readonly currency: CurrencyCode;
  readonly currencySymbol: string;
  readonly fxRatePerWcu: number;
  /** Development stage S0..S5 reached by the city actually built on the map (GDD §6.1). */
  readonly stage: string;
  /** Households living in the developers' finished blocks (drives the stage). */
  readonly cityHouseholds?: number;
  /** Next stage and the households it needs (absent at the last stage). */
  readonly nextStage?: { readonly stage: string; readonly nameRu: string; readonly minHouseholds: number };
  readonly treasuryBalanceMinor: string;
  readonly gdpWcu: number;
  readonly annualInflation: number;
  readonly keyRate: number;
  readonly reserveRequirement: number;
  readonly cbBondPurchaseShare: number;
  readonly swfSterilizationShare: number;
  readonly swfBalanceWcuMinor: string;
  readonly vatRate: number;
  readonly corpTaxRate: number;
  readonly importDutyRate: number;
  readonly creditRating: CreditRating;
  readonly debtToRevenue: number;
  readonly imfActive: boolean;
  readonly imfApprovedWcuMinor?: string;
  readonly imfDebtWcuMinor?: string;
  readonly imfTranchesDisbursed?: number;
  readonly households: number;
  readonly citizens: number;
  readonly happinessIndex: number;
  readonly hardshipShare: number;
  readonly powerDemandMw: number;
  readonly powerSupplyMw: number;
  readonly activeDecreeIds: readonly string[];
  readonly invariantValid: boolean;
  readonly maxErrorMinor: string;
  readonly hegemony: HegemonyScoreBreakdown;
  readonly lastMatrix: readonly SerializedMatrixRow[];
  readonly quests?: readonly StarterQuestStepDto[];
}

export interface NetworkSegmentDto {
  readonly id: string;
  readonly sectorId: SectorId;
  readonly kind: NetworkKind;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly hasBridge: boolean;
  readonly isFlyover: boolean;
  readonly healthPercent: number;
}

export interface BuildingDto {
  readonly id: string;
  readonly catalogId: string;
  readonly sectorId: SectorId | "core";
  readonly tileX: number;
  readonly tileY: number;
  readonly width: number;
  readonly depth: number;
  readonly orientationDeg: 0 | 45 | 90 | 135;
  readonly level: number;
  readonly constructionProgress: number;
  readonly cityEquityShare: number;
  readonly stalledAwaitingPrivate: boolean;
  /** Level being built by a timed upgrade (sheet 22); the plant keeps running at `level` meanwhile. */
  readonly upgradeTargetLevel?: number | null;
  /** 0..1 progress of the timed upgrade. */
  readonly upgradeProgress?: number;
  /** Normalized site land value score 0..100 (Sprint 6). */
  readonly landValue?: number;
  /** Dynamic visual/wealth class derived from land value (<40 P, 40..74 M, >=75 R). */
  readonly districtClass?: "P" | "M" | "R";
}

export interface ZoneDto {
  readonly id: string;
  readonly sectorId: SectorId;
  readonly zoneKind: ZoneKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly depth: number;
  readonly occupancyRatio: number;
  /** Normalized zone land value score 0..100 (Sprint 6). */
  readonly landValue?: number;
  /** Dynamic visual/wealth class derived from land value (<40 P, 40..74 M, >=75 R). */
  readonly districtClass?: "P" | "M" | "R";
}

export interface ActiveEmergencyDto {
  readonly instanceId: string;
  readonly emergencyId: EmergencyId;
  readonly sectorId: SectorId;
  readonly tileX: number;
  readonly tileY: number;
  readonly titleRu: string;
  readonly expiresAtGameSeconds: number;
  /** Why it happened (Sprint 6 organic emergencies). */
  readonly causeRu?: string;
  /** Building, road segment or zone hit by the emergency. */
  readonly targetRef?: string | null;
  /** A responder crew is assigned (otherwise it lasts 3x longer and leaves damage). */
  readonly attended?: boolean;
  readonly responders?: readonly EmergencyResponderDto[];
  readonly statusRu?: string;
}

export interface EmergencyResponderDto {
  readonly buildingId: string;
  readonly vehicleTypeId: string;
  readonly arrivesAtGameSeconds: number;
  readonly path: readonly number[];
}

export interface ChatMessageDto {
  readonly id: string;
  readonly timestampIso: string;
  readonly senderSector: SectorId | "system";
  readonly senderName: string;
  readonly channel: "council" | `dm:${SectorId}-${SectorId}`;
  readonly text: string;
}

// ---------------------------------------------------------------------------------------------
// Sprint 7: border posts, gas & power ring, megaprojects, exchange
// ---------------------------------------------------------------------------------------------

export type VisaRegimeId = "visa_free" | "paid_visa" | "skilled_quota" | "closed";
export type CargoLaneId = "raw" | "hydrocarbons" | "agri" | "manufactured" | "luxury";

/** One mayor's side of a border post. */
export interface BorderSidePolicyDto {
  readonly sectorId: SectorId;
  readonly visaRegime: VisaRegimeId;
  readonly importDuty: Readonly<Record<CargoLaneId, number>>;
  readonly exportDuty: Readonly<Record<CargoLaneId, number>>;
  readonly transitDuty?: Readonly<Record<CargoLaneId, number>>;
  readonly embargo: readonly CargoLaneId[];
  readonly inspection: "green" | "strict";
  readonly sanitaryQuarantine?: boolean;
  readonly gasValveOpen?: boolean;
}

export interface PendingBorderChangeDto {
  readonly sectorId: SectorId;
  readonly effectiveAtGameSeconds: number;
  readonly descriptionRu: string;
  readonly policy: BorderSidePolicyDto;
}

export interface BorderPostDto {
  readonly id: string;
  readonly sectorA: SectorId;
  readonly sectorB: SectorId;
  readonly tileX: number;
  readonly tileY: number;
  readonly width: number;
  readonly depth: number;
  readonly sides: readonly BorderSidePolicyDto[];
  readonly pending: readonly PendingBorderChangeDto[];
}

export interface BorderFlowDto {
  readonly fromSector: SectorId;
  readonly toSector: SectorId;
  readonly lane: CargoLaneId;
  readonly commodity: string;
  readonly trucksPerHour: number;
  readonly valuePerMonthWcuMinor: string;
}

export interface BorderPostStatsDto {
  readonly postId: string;
  readonly roadLinked: boolean;
  readonly trucksPerHour: number;
  readonly capacityTrucksPerHour: number;
  readonly queueMinutes: number;
  readonly crossersPerMonth: number;
  readonly flows: readonly BorderFlowDto[];
  /** Per side: customs duty, visa fees and the value lost to smuggling, per game month (local minor). */
  readonly revenue: ReadonlyArray<{
    readonly sectorId: SectorId;
    readonly dutyMinor: string;
    readonly visaMinor: string;
    readonly smuggledValueMinor: string;
  }>;
}

export interface SectorGasStatsDto {
  readonly sectorId: SectorId;
  readonly supplyKm3PerHour: number;
  readonly demandKm3PerHour: number;
  readonly importedKm3PerHour: number;
  readonly exportedKm3PerHour: number;
  readonly gasifiedPlants: number;
  readonly gasReadyPlants: number;
  readonly avgOutputBoost: number;
  readonly backupFuelOilBurned?: boolean;
}

export interface SectorPowerRingDto {
  readonly sectorId: SectorId;
  readonly supplyMw: number;
  readonly demandMw: number;
  readonly importedMw: number;
  readonly exportedMw: number;
  readonly partners: readonly SectorId[];
}

export interface MegaprojectStakeDto {
  readonly sectorId: SectorId;
  readonly contributedWcuMinor: string;
  readonly share: number;
}

export type MegaprojectResourceId = "Steel" | "Cement" | "Microchips" | "Industrial Machinery";

export interface MegaprojectDto {
  readonly buildingId: string;
  readonly catalogId: string;
  readonly nameRu: string;
  readonly costWcuMinor: string;
  readonly fundedWcuMinor: string;
  readonly status: "funding" | "building" | "operational";
  readonly constructionProgress: number;
  readonly monthlyDividendWcuMinor: string;
  readonly stakes: readonly MegaprojectStakeDto[];
  readonly bonusSummaryRu?: string;
  readonly requiredResources?: Readonly<Record<MegaprojectResourceId, number>>;
  readonly deliveredResources?: Readonly<Record<MegaprojectResourceId, number>>;
}

export interface ListedCompanyDto {
  readonly buildingId: string;
  readonly catalogId?: string;
  readonly sectorId: SectorId;
  readonly nameRu: string;
  readonly level: number;
  readonly annualRoi: number;
  readonly marketCapLocalMinor: string;
  readonly marketCapWcuMinor?: string;
  /** Price of 1% of the company in its home currency (minor units). */
  readonly pricePerPercentLocalMinor: string;
  readonly cityShare: number;
  readonly privateShare: number;
  readonly stalledAwaitingPrivate?: boolean;
  readonly foreignStakes: ReadonlyArray<{ readonly sectorId: SectorId; readonly share: number }>;
}

export interface PendingTakeoverDto {
  readonly id: string;
  readonly buildingId: string;
  readonly companyNameRu: string;
  readonly targetSectorId: SectorId;
  readonly bidderSectorId: SectorId;
  readonly deltaShare: number;
  readonly resultingShare: number;
  readonly bidPriceWcuMinor: string;
  readonly source: "treasury" | "swf";
  readonly effectiveAtGameSeconds: number;
}

export interface ConstructionMaterialStatsDto {
  readonly material: string;
  readonly nameRu: string;
  readonly demandTonsPerHour: number;
  readonly localTonsPerHour: number;
  /** Bought from a neighbour's plants across a border post (Sprint 7). */
  readonly neighborTonsPerHour: number;
  readonly importedTonsPerHour: number;
  readonly localCapacityTonsPerHour: number;
  readonly shortfallTonsPerHour: number;
  readonly localPricePerTonMinor: string;
  readonly importPricePerTonMinor: string;
}

/** Developer construction market of one sector over the last hourly step (Sprint 4, GDD §6.1). */
export interface SectorConstructionStatsDto {
  readonly sectorId: SectorId;
  readonly gatewayImportOpen: boolean;
  readonly importCapTonsPerHour: number;
  readonly demandTonsPerHour: number;
  readonly fillRatio: number;
  readonly activeSites: number;
  readonly stalledSites: number;
  readonly materials: readonly ConstructionMaterialStatsDto[];
  readonly importDutyMinor: string;
}

export interface ZoneSiteStatusDto {
  readonly zoneId: string;
  readonly fillRatio: number;
  readonly limitingMaterial: string | null;
}

export type VehicleRole = "commuter" | "freight" | "bus" | "metro" | "service" | "emergency";

export interface DistrictCoverageDto {
  readonly police: number;
  readonly fire: number;
  readonly health: number;
  readonly park: number;
  readonly kindergarten: number;
  readonly school: number;
  readonly higherEducation: number;
}

/** One zone as a district cell (Sprint 6, GDD §6.3). */
export interface DistrictDto {
  readonly zoneId: string;
  readonly sectorId: SectorId;
  readonly zoneKind: ZoneKind;
  readonly landValuePerTile: number;
  /** Normalized 0..100 land value score (<40 P, 40..74 M, >=75 R). */
  readonly landValueScore?: number;
  readonly tier: 1 | 2 | 3 | 4 | 5;
  readonly tierNameRu: string;
  readonly visualClass: "P" | "M" | "R";
  readonly crimeRate: number;
  readonly ecology: number;
  readonly happiness: number;
  readonly coverage: DistrictCoverageDto;
}

export interface SectorCityStatsDto {
  readonly sectorId: SectorId;
  readonly districts: number;
  readonly residents: number;
  readonly avgLandValuePerTile: number;
  readonly avgCrimeRate: number;
  readonly avgEcology: number;
  readonly districtHappiness: number;
  readonly residentsByTier: readonly number[];
  readonly coverage: DistrictCoverageDto;
  readonly stations: ReadonlyArray<{ readonly buildingId: string; readonly kind: string; readonly capacity: number; readonly demand: number }>;
}

export interface SectorAutoStatsDto {
  readonly sectorId: SectorId;
  readonly fleetByStage: readonly number[];
  readonly targetFleet: number;
  readonly dealership: boolean;
  readonly usedLot: boolean;
  readonly repairShops: number;
  readonly scrapyards: number;
  readonly newCarsPerMonth: number;
  readonly newCarsImported: boolean;
  readonly newCarPriceUnits: number;
  readonly breakdownsPerMonth: number;
  readonly repairedPerMonth: number;
  readonly strandedPerMonth: number;
  readonly scrapTonsPerMonth: number;
  readonly scrapRecycledTonsPerMonth: number;
  readonly avgCarValueUnits: number;
}

export interface AdvisorTipDto {
  readonly severity: "critical" | "warning" | "info";
  readonly text: string;
  readonly hint: string;
}

export interface AdvisorDto {
  readonly advisorId: "urban" | "finance" | "logistics";
  readonly nameRu: string;
  readonly tips: readonly AdvisorTipDto[];
}

/** One visible vehicle sampled from the real flows; the client animates it along `path` at 60 FPS. */
export interface VehicleAgentDto {
  readonly id: string;
  readonly vehicleTypeId: string;
  readonly role: VehicleRole;
  readonly sectorId: SectorId;
  readonly layer: "surface" | "underground";
  /** Flat polyline `[x0, y0, x1, y1, ...]` in tile coordinates; vehicles shuttle back and forth. */
  readonly path: readonly number[];
  readonly pathLengthTiles: number;
  readonly speedTilesPerSec: number;
  readonly phase: number;
  readonly colorHex: number;
}

export type RoadConditionStageDto = "good" | "potholes" | "emergency";

export interface SegmentTrafficDto {
  readonly segmentId: string;
  readonly vehiclesPerHour: number;
  readonly heavyVehiclesPerHour: number;
  readonly esalPerHour: number;
  readonly volumeCapacityRatio: number;
  readonly speedFactor: number;
  readonly wearPercentPerHour: number;
  readonly stage: RoadConditionStageDto;
}

export interface SectorTransportStatsDto {
  readonly sectorId: SectorId;
  readonly carTripsPerHour: number;
  readonly truckTripsPerHour: number;
  readonly transitRidersPerHour: number;
  readonly busRoutes: number;
  readonly busCoverageShare: number;
  readonly metroStations: number;
  readonly metroOperational: boolean;
  readonly metroCoverageShare: number;
  readonly metroLandValueBoostShare: number;
  readonly avgRoadHealth: number;
  readonly congestedSegments: number;
  readonly damagedSegments: number;
  readonly roadServiceLevel: 0 | 1 | 2;
  readonly roadServiceMonthlyCostMinor: string;
}

export interface BusRouteDto {
  readonly id: string;
  readonly sectorId: SectorId;
  readonly name: string;
  readonly operatorName: string;
  readonly stopBuildingIds: readonly string[];
  readonly fleetSize: number;
  readonly vehicleTypeId: string;
  readonly licenseFeeMonthlyMinor: string;
}

export interface BusRouteStatusDto {
  readonly routeId: string;
  readonly operating: boolean;
  readonly statusRu: string;
  readonly lengthTiles: number;
  readonly busesPerHour: number;
  readonly path: readonly number[];
}

export interface TrafficStateDto {
  readonly version: number;
  readonly gameHourOfDay: number;
  readonly vehicles: readonly VehicleAgentDto[];
  readonly segments: readonly SegmentTrafficDto[];
  readonly sectors: readonly SectorTransportStatsDto[];
  readonly busRoutes: readonly BusRouteStatusDto[];
}

export interface VehicleInspectorDto {
  readonly id: string;
  readonly vehicleTypeId: string;
  readonly typeNameRu: string;
  readonly role: VehicleRole;
  readonly sectorId: SectorId;
  readonly plate: string;
  readonly liveryColorHex: number;
  readonly ownerLabel: string;
  readonly originLabel: string;
  readonly waypointLabel: string;
  readonly destinationLabel: string;
  readonly cargo: {
    readonly commodity: string;
    readonly payload: number;
    readonly capacity: number;
    readonly unit: string;
    readonly valueMinor: string;
    readonly dutyPaidMinor: string;
    readonly dutyLabel: string;
  } | null;
  readonly passengers: { readonly onboard: number; readonly capacity: number } | null;
  readonly currencySymbol: string;
  readonly speedKmh: number;
  readonly speedLimitKmh: number;
  readonly avgRoadHealth: number;
  readonly roadWearFactor: number;
  readonly roadWearPerPassPercent: number;
  readonly driverCitizenId: string;
  readonly shiftHoursRemaining: number;
}

export interface DossierLineDto {
  readonly label: string;
  readonly amountMinor: string;
}

export interface CitizenThoughtDto {
  readonly text: string;
  readonly delta: number;
}

export interface CitizenCarDto {
  readonly modelName: string;
  readonly stage: 1 | 2 | 3 | 4 | 5;
  readonly stageNameRu: string;
  readonly ageYears: number;
  readonly wearPercent: number;
  readonly marketValueMinor: string;
  readonly monthlyFuelMinor: string;
  readonly monthlyStoMinor: string;
  readonly purchaseHistoryRu: string;
}

export interface CitizenDossierDto {
  readonly id: string;
  readonly fullName: string;
  readonly age: number;
  readonly classId: "workers" | "engineers" | "elite" | "retirees";
  readonly classNameRu: string;
  readonly statusRu: string;
  readonly familyRu: string;
  readonly sectorId: SectorId;
  readonly home: { readonly label: string; readonly tileX: number; readonly tileY: number };
  readonly workplace: { readonly label: string; readonly roleRu: string; readonly tileX: number; readonly tileY: number };
  readonly commuteKm: number;
  readonly commuteModeRu: string;
  readonly currencySymbol: string;
  readonly income: readonly DossierLineDto[];
  readonly expenses: readonly DossierLineDto[];
  readonly totalIncomeMinor: string;
  readonly totalExpensesMinor: string;
  readonly netSavingsMinor: string;
  readonly savingsRate: number;
  readonly cumulativeReserveMinor: string;
  readonly satisfaction: number;
  readonly thoughts: readonly CitizenThoughtDto[];
  readonly vehicleId: string | null;
  readonly car?: CitizenCarDto | null;
}

export interface WorldSnapshotDto {
  readonly worldId: string;
  readonly seasonDay: number;
  readonly calendar: DualCalendarSnapshot;
  readonly invariantAllZero: boolean;
  readonly sectors: readonly SectorSummaryDto[];
  readonly segments: readonly NetworkSegmentDto[];
  readonly buildings: readonly BuildingDto[];
  readonly zones: readonly ZoneDto[];
  readonly emergencies: readonly ActiveEmergencyDto[];
  readonly recentChat: readonly ChatMessageDto[];
  readonly trafficVersion: number;
  readonly busRoutes: readonly BusRouteDto[];
  readonly transport: readonly SectorTransportStatsDto[];
  readonly construction: readonly SectorConstructionStatsDto[];
  readonly zoneSites: readonly ZoneSiteStatusDto[];
  readonly districts: readonly DistrictDto[];
  readonly city: readonly SectorCityStatsDto[];
  readonly autos: readonly SectorAutoStatsDto[];
  /** Advisors of every sector (the client shows the active one). */
  readonly advisors: ReadonlyArray<{ readonly sectorId: SectorId; readonly advisors: readonly AdvisorDto[] }>;
  readonly borderPosts: readonly BorderPostDto[];
  readonly borderStats: readonly BorderPostStatsDto[];
  readonly gas: readonly SectorGasStatsDto[];
  readonly powerRing: readonly SectorPowerRingDto[];
  readonly megaprojects: readonly MegaprojectDto[];
  readonly exchange: readonly ListedCompanyDto[];
  readonly pendingTakeovers?: readonly PendingTakeoverDto[];
}

export type ClientCommand =
  | {
      type: "claim_sector";
      sectorId: SectorId;
      cityName: string;
      mayorName: string;
      currency: CurrencyCode;
    }
  | {
      type: "reset_sector";
      sectorId: SectorId;
    }
  | {
      type: "build_segment";
      sectorId: SectorId;
      kind: NetworkKind;
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      isFlyover?: boolean;
    }
  | {
      type: "paint_zone";
      sectorId: SectorId;
      zoneKind: ZoneKind;
      x: number;
      y: number;
      width: number;
      depth: number;
    }
  | {
      type: "place_building";
      sectorId: SectorId;
      catalogId: string;
      tileX: number;
      tileY: number;
      orientationDeg?: 0 | 45 | 90 | 135;
      cityShareOverride?: number;
    }
  | {
      type: "buyout_factory";
      sectorId: SectorId;
      buildingId: string;
    }
  | {
      type: "upgrade_building";
      sectorId: SectorId;
      buildingId: string;
      mayorPaysAll?: boolean;
    }
  | {
      type: "bulldoze_building";
      sectorId: SectorId;
      buildingId: string;
    }
  | {
      type: "demolish_building";
      sectorId: SectorId;
      buildingId: string;
    }
  | {
      type: "demolish_zone";
      sectorId: SectorId;
      zoneId: string;
    }
  | {
      type: "upgrade_zone";
      sectorId: SectorId;
      zoneId: string;
      targetZoneKind?: ZoneKind;
    }
  | {
      type: "update_policy";
      sectorId: SectorId;
      preset?: MayorPolicyPreset;
      keyRate?: number;
      useTaylorAdvisor?: boolean;
      reserveRequirement?: number;
      cbBondPurchaseShare?: number;
      swfSterilizationShare?: number;
      vatRate?: number;
      corpTaxRate?: number;
      importDutyRate?: number;
      cityNewPlantShare?: number;
      toggleDecreeId?: string;
      roadServiceLevel?: 0 | 1 | 2;
    }
  | {
      type: "create_bus_route";
      sectorId: SectorId;
      stopBuildingIds: string[];
      fleetSize?: number;
      name?: string;
    }
  | {
      type: "delete_bus_route";
      sectorId: SectorId;
      routeId: string;
    }
  | {
      type: "set_border_policy";
      sectorId: SectorId;
      postId: string;
      visaRegime?: VisaRegimeId;
      importDuty?: Partial<Record<CargoLaneId, number>>;
      exportDuty?: Partial<Record<CargoLaneId, number>>;
      transitDuty?: Partial<Record<CargoLaneId, number>>;
      embargo?: CargoLaneId[];
      inspection?: "green" | "strict";
      sanitaryQuarantine?: boolean;
      gasValveOpen?: boolean;
    }
  | {
      type: "set_gas_valve";
      sectorId: SectorId;
      postId: string;
      open: boolean;
    }
  | {
      type: "found_megaproject";
      sectorId: SectorId;
      catalogId: "MEG-01" | "MEG-02" | "MEG-03" | "MEG-04";
    }
  | {
      type: "contribute_megaproject";
      sectorId: SectorId;
      buildingId: string;
      amountUnits: number;
      source: "treasury" | "swf";
      caravanCommodity?: MegaprojectResourceId;
      caravanTons?: number;
    }
  | {
      /** Buy (+) or sell (−) a share of a listed plant; the city's own plant or a neighbour's. */
      type: "trade_stake";
      sectorId: SectorId;
      buildingId: string;
      deltaShare: number;
      source: "treasury" | "swf";
    }
  | {
      /** Home mayor right-of-first-refusal buyout during a >25% foreign takeover notice window. */
      type: "preempt_takeover";
      sectorId: SectorId;
      takeoverId: string;
      source: "treasury" | "swf";
    }
  | {
      type: "repair_road";
      sectorId: SectorId;
      /** Omit to resurface every damaged road of the sector. */
      segmentId?: string;
    }
  | {
      type: "send_chat";
      senderSector: SectorId;
      channel: "council" | `dm:${SectorId}-${SectorId}`;
      text: string;
    }
  | {
      /** Claim a starter 15-minute onboarding quest grant (booked World -> T via RegionalMoneyEngine). */
      type: "claim_quest_reward";
      sectorId: SectorId;
      stepId: StarterQuestStepId;
    }
  | {
      type: "admin_time_skip";
      jump: "1h" | "1d" | "1mo" | "1yr";
    }
  | {
      type: "admin_trigger_emergency";
      sectorId: SectorId;
      emergencyId: EmergencyId;
    };

export type ServerMessage =
  | { type: "world_snapshot"; snapshot: WorldSnapshotDto }
  | { type: "command_result"; ok: boolean; message: string }
  | { type: "notice_alert"; message: string }
  | { type: "traffic_state"; traffic: TrafficStateDto };
