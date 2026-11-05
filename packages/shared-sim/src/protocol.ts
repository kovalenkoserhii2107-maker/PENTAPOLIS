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

export interface SectorSummaryDto {
  readonly sectorId: SectorId;
  readonly occupied: boolean;
  readonly cityName: string;
  readonly mayorName: string;
  readonly isAiGovernor: boolean;
  readonly currency: CurrencyCode;
  readonly currencySymbol: string;
  readonly fxRatePerWcu: number;
  readonly stage: string;
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
}

export interface ActiveEmergencyDto {
  readonly instanceId: string;
  readonly emergencyId: EmergencyId;
  readonly sectorId: SectorId;
  readonly tileX: number;
  readonly tileY: number;
  readonly titleRu: string;
  readonly expiresAtGameSeconds: number;
}

export interface ChatMessageDto {
  readonly id: string;
  readonly timestampIso: string;
  readonly senderSector: SectorId | "system";
  readonly senderName: string;
  readonly channel: "council" | `dm:${SectorId}-${SectorId}`;
  readonly text: string;
}

export type VehicleRole = "commuter" | "freight" | "bus" | "metro";

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
