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
  | { type: "notice_alert"; message: string };
