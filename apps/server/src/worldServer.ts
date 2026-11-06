/**
 * Authoritative World Simulation Engine (`@pentapolis/server`).
 *
 * Bridges:
 * - `RegionalMoneyEngine` (5-currency `BigInt` double-entry ledger, 0n error invariants);
 * - `generatePeninsulaMap()` (1000×1000 flat grid + 90°/45° network + river bridges);
 * - `getMasterCatalogs()` (127 buildings, 24 chains, 56 vehicles, 8 decrees, 12 emergencies);
 * - `computeTraffic()` (Sprint 5: commuter/freight/bus/metro flows, axle-load road wear, agent dossiers);
 * - `WorldDatabase` (`bun:sqlite` in WAL mode).
 */
import {
  AVERAGE_REPAIR_TICKET_UNITS,
  BUS_LICENSE_FEE_PER_BUS_PER_MONTH_UNITS,
  CANONICAL_EMERGENCIES,
  CARGO_LANES,
  DWELLINGS_PER_RESIDENTIAL_TILE,
  FOREIGN_TAKEOVER_NOTICE_DAYS,
  FOREIGN_TAKEOVER_NOTICE_THRESHOLD,
  MEGAPROJECT_RESOURCE_NAMES_RU,
  MEGAPROJECT_SPECS,
  POWER_RING_PREMIUM,
  districtClassForScore,
  fusionPowerShares,
  getCarStages,
  getCustomsTables,
  isListable,
  laneOpen,
  megaprojectDividends,
  megaprojectStatus,
  noticeDaysFor,
  runGasNetwork,
  runPowerRing,
  stakeMonthlyDividend,
  valueListedCompany,
  wholesalePowerPricePerMwh,
  ON_SITE_HOURS,
  UNATTENDED_DURATION_MULTIPLIER,
  buildAdvisors,
  computeCityServices,
  planDispatch,
  rollDailyEmergencies,
  runAutoMarket,
  GAME_HOURS_PER_MONTH,
  MIN_ROAD_HEALTH_PERCENT,
  ROAD_SERVICE_RESTORE_PERCENT_PER_MONTH,
  NATIONAL_CURRENCIES,
  OwnerCode,
  RegionalMoneyEngine,
  SurfaceType,
  absBig,
  buildCitizenDossier,
  buildNetworkGraph,
  connectedComponents,
  locateOnGraph,
  runDeveloperMarket,
  zoneMaterialBill,
  buildVehicleInspector,
  computeBuildingAtLevel,
  computeCreditRating,
  computeDualCalendar,
  computeHegemonyScores,
  computeTraffic,
  formatMoney,
  generatePeninsulaMap,
  getCurrencySpec,
  getMasterCatalogs,
  isRoadKind,
  locateRectOnGraph,
  maxBig,
  money,
  mulRate,
  roadConditionStage,
  roadRepairCost,
  roadServiceMonthlyCost,
  toUnits,
  validateAndQuoteNetworkSegment,
  type ActiveEmergencyDto,
  type BuildingDto,
  type BusRouteDto,
  type ChatMessageDto,
  type CitizenDossierDto,
  type ClientCommand,
  type CurrencyCode,
  type MasterCatalogs,
  type Money,
  type NetworkSegmentDto,
  type PeninsulaMapData,
  type RoadServiceLevel,
  type AdvisorDto,
  type BorderPostDto,
  type BorderPostStatsDto,
  type BorderSidePolicyDto,
  type CrossBorderFlow,
  type ForeignStakeRecord,
  type GasNetworkResult,
  type ListedCompanyDto,
  type MegaprojectCatalogId,
  type MegaprojectDto,
  type MegaprojectResourceId,
  type MegaprojectStakeRecord,
  type PendingTakeoverDto,
  type SectorPowerRingDto,
  type CityModelResult,
  type EmergencySpawn,
  type SectorAutoStatsDto,
  type SectorFleetState,
  type SectorConstructionStatsDto,
  type ZoneSiteStatusDto,
  type SectorId,
  type SectorSummaryDto,
  type SerializedMatrixRow,
  type StarterQuestStepDto,
  type StarterQuestStepId,
  type TrafficComputation,
  type TrafficStateDto,
  type VehicleInspectorDto,
  type WorldSnapshotDto,
  type ZoneDto,
  type ZoneKind,
} from "@pentapolis/shared-sim";
import { WorldDatabase } from "./db.ts";
import {
  borderLinks,
  borderPostSides,
  borderPostStats,
  crossingTerms,
  describePolicy,
  isBlockaded,
  materialTradePartners,
  newBorderPost,
  sideOf,
} from "./geopolitics.ts";

export interface CommandOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly noticeAlerts?: readonly string[];
}

const SECTOR_IDS: readonly SectorId[] = [1, 2, 3, 4, 5];

/** Tier 3 tactical tick (GDD §1.4): 20 real seconds = 10 game minutes. */
export const TACTICAL_TICK_GAME_SECONDS = 600;

/** Power plants that generate (substations, gas nodes and holders only route). */
const GENERATOR_IDS: ReadonlySet<string> = new Set(["ENG-01", "ENG-02", "ENG-03"]);
/** AI Governor repairs roads below this health when the treasury allows (GDD §1.2). */
const AI_GOVERNOR_REPAIR_BELOW = 50;

const BUS_OPERATORS = ["Горавтотранс", "ЭкспрессЛайн", "Сити-Бас", "Транзит-Плюс", "Полуостров-Авто", "Пятиград-Тур"];

/** Commands after which the traffic flows must be re-routed. */
const TRAFFIC_AFFECTING_COMMANDS: ReadonlySet<ClientCommand["type"]> = new Set([
  "reset_sector",
  "build_segment",
  "paint_zone",
  "upgrade_zone",
  "demolish_zone",
  "place_building",
  "buyout_factory",
  "upgrade_building",
  "bulldoze_building",
  "demolish_building",
  "update_policy",
  "create_bus_route",
  "delete_bus_route",
  "repair_road",
  "set_border_policy",
  "set_gas_valve",
  "found_megaproject",
  "contribute_megaproject",
  "trade_stake",
  "preempt_takeover",
]);

function fmtSym(amount: Money, symbol: string): string {
  return `${symbol} ${formatMoney(amount)}`;
}

function currencySymbol(code: CurrencyCode): string {
  try {
    return getCurrencySpec(code).symbol;
  } catch {
    return code;
  }
}

export class WorldSimulation {
  public readonly worldId: string;
  public readonly catalogs: MasterCatalogs;
  public readonly map: PeninsulaMapData;
  public readonly db: WorldDatabase;
  public readonly engine: RegionalMoneyEngine;

  private totalGameSeconds = 0;
  private lastHourProcessed = 0;
  private lastDayProcessed = 0;
  private lastMonthProcessed = 0;
  private entitySeq = 1;

  private readonly occupiedBySector = new Map<SectorId, boolean>([
    [1, false],
    [2, false],
    [3, false],
    [4, false],
    [5, false],
  ]);
  private readonly segments = new Map<string, NetworkSegmentDto>();
  private readonly zones = new Map<string, ZoneDto>();
  private readonly buildings = new Map<string, BuildingDto>();
  private readonly emergencies: ActiveEmergencyDto[] = [];
  private readonly recentChat: ChatMessageDto[] = [];
  private readonly busRoutes = new Map<string, BusRouteDto>();
  private readonly roadServiceLevel = new Map<SectorId, RoadServiceLevel>(
    SECTOR_IDS.map((s) => [s, 1 as RoadServiceLevel])
  );
  private traffic: TrafficComputation | null = null;
  private trafficVersion = 0;
  private trafficDirty = true;
  private lastTacticalSlot = 0;
  private lastConstruction: { sectors: SectorConstructionStatsDto[]; zoneSites: ZoneSiteStatusDto[] } | null = null;
  private city: CityModelResult | null = null;
  private autoStats: SectorAutoStatsDto[] = [];
  private readonly borderPosts = new Map<string, BorderPostDto>();
  private borderStats: BorderPostStatsDto[] = [];
  private crossBorderFlows: readonly CrossBorderFlow[] = [];
  private gas: GasNetworkResult | null = null;
  /** Megaproject contributions in WCU minor units, keyed `buildingId|sectorId`. */
  private readonly megaStakes = new Map<string, MegaprojectStakeRecord>();
  private readonly megaResources = new Map<string, Partial<Record<MegaprojectResourceId, number>>>();
  private readonly foreignStakes: ForeignStakeRecord[] = [];
  private readonly pendingTakeovers: PendingTakeoverDto[] = [];
  private readonly fleets = new Map<SectorId, SectorFleetState>(
    SECTOR_IDS.map((sectorId) => [sectorId, { sectorId, fleet: [0, 0, 0, 0, 0] }])
  );
  private readonly claimedQuests = new Map<SectorId, Set<StarterQuestStepId>>(
    SECTOR_IDS.map((sectorId) => [sectorId, new Set<StarterQuestStepId>()])
  );

  constructor(dbPath = ":memory:", fixedWorldId?: string) {
    this.catalogs = getMasterCatalogs();
    this.map = generatePeninsulaMap();
    this.db = new WorldDatabase(dbPath);
    this.engine = new RegionalMoneyEngine({ mode: "mature" });

    const savedWorldId = this.db.getMeta("worldId");
    if (savedWorldId) {
      this.worldId = savedWorldId;
      this.restoreFromDatabase();
    } else {
      this.worldId = fixedWorldId ?? `pentapolis-${Date.now().toString(36)}`;
      this.bootstrapFreshWorld();
    }
  }

  private bootstrapFreshWorld(): void {
    this.db.setMeta("worldId", this.worldId);

    // Run 1 baseline macro step so all 5 regions have initial 7-column matrices (`0n` error),
    // then set every sector's starting Municipal Treasury to $10,000,000 local units (GDD §1.5, §6.1).
    // The clock starts at 0: hourly/daily steps count from 0, the month-1 baseline is already booked.
    const initialReports = this.engine.stepMonth();
    this.lastMonthProcessed = 1;
    this.lastDayProcessed = 0;
    this.lastHourProcessed = 0;
    this.totalGameSeconds = 0;
    this.db.setMeta("totalGameSeconds", "0");

    for (const rep of initialReports) {
      const maxErr = maxBig(
        maxBig(rep.invariants.maxRowError, rep.invariants.maxColError),
        maxBig(absBig(rep.invariants.cbColumnIndependentSum), rep.invariants.moneyDecompositionDiff)
      );
      this.db.insertLedgerSnapshot({
        month: rep.month,
        sectorId: rep.sectorId,
        currency: rep.currency,
        fxRate: rep.fxRatePerWcu,
        gdpWcu: rep.gdpWcu,
        invariantValid: rep.invariants.valid,
        maxErrorMinor: maxErr.toString(),
      });
    }

    for (const sectorId of SECTOR_IDS) {
      const reg = this.engine.getRegion(sectorId);
      const profile = this.catalogs.sectors.find((s) => s.sectorId === sectorId);
      reg.cityName = profile ? `${profile.nameRu} (S${sectorId})` : `Сектор ${sectorId}`;
      reg.mayorDisplayName = "ИИ-Управляющий (Свободно)";
      reg.treasuryCashAtCb = money(10_000_000);
      this.occupiedBySector.set(sectorId, false);
      this.db.saveSectorClaim({
        sectorId,
        occupied: false,
        cityName: reg.cityName,
        mayorName: reg.mayorDisplayName,
        currency: reg.currency,
        treasuryMinor: reg.treasuryCashAtCb.toString(),
        claimedAtMs: 0,
      });
    }

    // Seed the 5 starter External World Gateway 2-lane highway/tunnel ramp stubs
    this.seedGatewayRoadStubs();

    this.pushSystemChat(
      "Добро пожаловать в Пентаполис! Полуостров открыт: 5 секторов, общая сетка 1000×1000 без тумана войны и суверенная двухконтурная экономика."
    );
  }

  private seedGatewayRoadStubs(): void {
    for (const gw of this.map.gateways) {
      const id = `GW-STUB-S${gw.sectorId}`;
      if (this.segments.has(id)) continue;
      const toX = gw.kind === "overland_highway" ? gw.tileX : gw.tileX + (gw.sectorId === 3 ? -8 : gw.sectorId === 5 ? 8 : 0);
      const toY = gw.kind === "overland_highway" ? gw.tileY + 10 : gw.tileY + (gw.sectorId === 4 ? 8 : 0);
      const seg: NetworkSegmentDto = {
        id,
        sectorId: gw.sectorId,
        kind: "street_2lane",
        fromX: gw.tileX,
        fromY: gw.tileY,
        toX,
        toY,
        hasBridge: false,
        isFlyover: false,
        healthPercent: 100,
      };
      this.segments.set(id, seg);
      this.db.upsertSegment(seg);
    }
  }

  private restoreFromDatabase(): void {
    // Run 1 baseline macro step so `lastReport` matrices are populated
    this.engine.stepMonth();
    this.totalGameSeconds = Number(this.db.getMeta("totalGameSeconds") ?? "0");
    const cal = computeDualCalendar(this.totalGameSeconds, this.catalogs.unitsAndTime.timeBase);
    this.lastHourProcessed = Math.floor(this.totalGameSeconds / 3600);
    this.lastDayProcessed = Math.floor(this.totalGameSeconds / 86_400);
    this.lastMonthProcessed = Math.max(1, cal.economicMonth);

    for (const claim of this.db.loadSectorClaims()) {
      const reg = this.engine.getRegion(claim.sectorId);
      this.occupiedBySector.set(claim.sectorId, claim.occupied);
      reg.cityName = claim.cityName;
      reg.mayorDisplayName = claim.mayorName;
      reg.mayorUid = claim.occupied ? `mayor-s${claim.sectorId}` : null;
      reg.currency = claim.currency;
      reg.treasuryCashAtCb = BigInt(claim.treasuryMinor);
    }

    for (const seg of this.db.loadSegments()) {
      this.segments.set(seg.id, seg);
    }
    if (this.segments.size === 0) {
      this.seedGatewayRoadStubs();
    }
    for (const z of this.db.loadZones()) {
      this.zones.set(z.id, z);
    }
    for (const b of this.db.loadBuildings()) {
      this.buildings.set(b.id, b);
    }
    for (const msg of this.db.loadRecentChat(60)) {
      this.recentChat.push(msg);
    }
    for (const route of this.db.loadBusRoutes()) {
      this.busRoutes.set(route.id, route);
    }
    for (const post of this.db.loadBorderPosts()) {
      this.borderPosts.set(post.id, post);
    }
    for (const st of this.db.loadMegaprojectStakes()) {
      this.megaStakes.set(`${st.buildingId}|${st.sectorId}`, {
        buildingId: st.buildingId,
        sectorId: st.sectorId,
        contributedWcu: BigInt(st.contributedWcuMinor),
      });
    }
    for (const st of this.db.loadEquityStakes()) {
      this.foreignStakes.push({ buildingId: st.buildingId, holderSector: st.holderSector, share: st.share });
    }
    const savedTakeovers = this.db.getMeta("pendingTakeovers");
    if (savedTakeovers) {
      try {
        const parsed = JSON.parse(savedTakeovers) as PendingTakeoverDto[];
        if (Array.isArray(parsed)) this.pendingTakeovers.push(...parsed);
      } catch {
        // Ignore malformed meta
      }
    }
    const savedMegaRes = this.db.getMeta("megaResources");
    if (savedMegaRes) {
      try {
        const parsed = JSON.parse(savedMegaRes) as Array<[string, Partial<Record<MegaprojectResourceId, number>>]>;
        for (const [k, v] of parsed) this.megaResources.set(k, v);
      } catch {
        // Ignore malformed meta
      }
    }
    for (const sectorId of SECTOR_IDS) {
      const fleet = this.db.getMeta(`fleet:S${sectorId}`);
      if (fleet) {
        const parsed = JSON.parse(fleet) as number[];
        if (parsed.length === 5) this.fleets.get(sectorId)!.fleet = parsed as SectorFleetState["fleet"];
      }
      const saved = Number(this.db.getMeta(`roadService:S${sectorId}`) ?? "1");
      this.roadServiceLevel.set(sectorId, (saved === 0 || saved === 2 ? saved : 1) as RoadServiceLevel);
      const savedQuests = this.db.getMeta(`quests:S${sectorId}`);
      if (savedQuests) {
        try {
          const parsed = JSON.parse(savedQuests) as StarterQuestStepId[];
          if (Array.isArray(parsed)) {
            this.claimedQuests.set(sectorId, new Set(parsed.filter((n): n is StarterQuestStepId => n >= 1 && n <= 4)));
          }
        } catch {
          // Ignore malformed quest meta
        }
      }
    }
    this.lastTacticalSlot = Math.floor(this.totalGameSeconds / TACTICAL_TICK_GAME_SECONDS);
    this.entitySeq =
      this.segments.size +
      this.zones.size +
      this.buildings.size +
      this.recentChat.length +
      this.busRoutes.size +
      10;
    // Restored ids may be sparse after bulldozing; keep new ids clear of every stored one
    for (const id of [...this.segments.keys(), ...this.zones.keys(), ...this.buildings.keys(), ...this.busRoutes.keys(), ...this.recentChat.map((m) => m.id)]) {
      const n = Number(id.split("-").pop());
      if (Number.isFinite(n) && n >= this.entitySeq) this.entitySeq = n + 1;
    }
  }

  private nextId(prefix: string): string {
    this.entitySeq += 1;
    return `${prefix}-${this.entitySeq}`;
  }

  private pushSystemChat(text: string): void {
    const msg: ChatMessageDto = {
      id: this.nextId("chat"),
      timestampIso: new Date().toISOString(),
      senderSector: "system",
      senderName: "Совет Полуострова",
      channel: "council",
      text,
    };
    this.recentChat.push(msg);
    if (this.recentChat.length > 80) this.recentChat.shift();
    this.db.insertChat(msg);
  }

  private persistSectorState(sectorId: SectorId): void {
    const reg = this.engine.getRegion(sectorId);
    this.db.saveSectorClaim({
      sectorId,
      occupied: this.occupiedBySector.get(sectorId) ?? false,
      cityName: reg.cityName,
      mayorName: reg.mayorDisplayName,
      currency: reg.currency,
      treasuryMinor: reg.treasuryCashAtCb.toString(),
      claimedAtMs: reg.lastMayorActivityEpochMs,
    });
  }

  /**
   * Advances real-time micro-tick (`1s` real = `30s` game time by default) and cascades
   * tactical (`600s`: traffic re-routing), hourly (`3,600s`: construction, zones, road wear),
   * daily (`86,400s`), and monthly (`2,592,000s`) simulation steps.
   */
  public advanceGameSeconds(deltaGameSeconds: number): string[] {
    if (deltaGameSeconds <= 0) return [];
    const alerts: string[] = [];
    this.totalGameSeconds += deltaGameSeconds;
    this.db.setMeta("totalGameSeconds", String(this.totalGameSeconds));

    for (const alert of this.applyDueBorderChanges()) {
      alerts.push(alert);
      this.pushSystemChat(alert);
    }
    for (const alert of this.applyDueTakeovers()) {
      alerts.push(alert);
      this.pushSystemChat(alert);
    }

    const tacticalSlot = Math.floor(this.totalGameSeconds / TACTICAL_TICK_GAME_SECONDS);
    if (tacticalSlot !== this.lastTacticalSlot) {
      this.lastTacticalSlot = tacticalSlot;
      this.trafficDirty = true;
    }

    const totalHoursNow = Math.floor(this.totalGameSeconds / 3600);
    const hoursDelta = totalHoursNow - this.lastHourProcessed;
    if (hoursDelta > 0) {
      this.lastHourProcessed = totalHoursNow;
      for (const alert of this.stepGameHours(hoursDelta)) {
        alerts.push(alert);
        this.pushSystemChat(alert);
      }
    }

    const totalDaysNow = Math.floor(this.totalGameSeconds / 86_400);
    const daysDelta = totalDaysNow - this.lastDayProcessed;
    if (daysDelta > 0) {
      this.lastDayProcessed = totalDaysNow;
      const notices = this.engine.advanceGameDays(daysDelta);
      for (const n of notices) {
        const alertText = `Вступила в силу мера: ${n.descriptionRu}`;
        alerts.push(alertText);
        this.pushSystemChat(alertText);
      }
      for (const alert of this.stepGameDays(totalDaysNow - daysDelta + 1, daysDelta)) {
        alerts.push(alert);
        this.pushSystemChat(alert);
      }
    }

    const totalMonthsNow = Math.floor(this.totalGameSeconds / (86_400 * 30)) + 1;
    while (this.lastMonthProcessed < totalMonthsNow) {
      this.lastMonthProcessed += 1;
      // Book monthly geopolitics & municipal transit cashflows into the 7-column ledger before stepMonth()
      const geoNetBySector = new Map<SectorId, Money>();
      for (const sid of SECTOR_IDS) {
        geoNetBySector.set(sid, this.bookAndComputeMonthlyGeopolitics(sid));
        if (this.occupiedBySector.get(sid)) {
          const roadBill = this.sectorRoadServiceCost(sid);
          if (roadBill > 0n) {
            this.engine.bookLedgerEntry(sid, [
              "Municipal road service (T -> Fc)",
              0n,
              roadBill,
              0n,
              -roadBill,
              0n,
              0n,
              0n,
            ]);
          }
          let busFees = 0n;
          for (const route of this.busRoutes.values()) {
            if (route.sectorId === sid) busFees += BigInt(route.licenseFeeMonthlyMinor);
          }
          if (busFees > 0n) {
            this.engine.bookLedgerEntry(sid, [
              "City bus licence fees (Fc -> T)",
              0n,
              -busFees,
              0n,
              busFees,
              0n,
              0n,
              0n,
            ]);
          }
        }
      }
      const reports = this.engine.stepMonth();
      for (const rep of reports) {
        const reg = this.engine.getRegion(rep.sectorId);
        // Credit monthly positive municipal operating surplus (scaled smoothly for active build phase)
        if (rep.budgetBalance > 0n) {
          reg.treasuryCashAtCb += mulRate(rep.budgetBalance, 0.04);
        }
        // Sprint 7 cross-border settlement (customs, visas, power ring, gas, backup mazut, dividends)
        reg.treasuryCashAtCb += geoNetBySector.get(rep.sectorId) ?? 0n;
        // Road Service bill and bus licence fees (Sprint 5) for mayor-run sectors
        if (this.occupiedBySector.get(rep.sectorId)) {
          reg.treasuryCashAtCb -= this.sectorRoadServiceCost(rep.sectorId);
          for (const route of this.busRoutes.values()) {
            if (route.sectorId === rep.sectorId) reg.treasuryCashAtCb += BigInt(route.licenseFeeMonthlyMinor);
          }
        }
        this.persistSectorState(rep.sectorId);

        const maxErr = maxBig(
          maxBig(rep.invariants.maxRowError, rep.invariants.maxColError),
          maxBig(
            absBig(rep.invariants.cbColumnIndependentSum),
            rep.invariants.moneyDecompositionDiff
          )
        );
        this.db.insertLedgerSnapshot({
          month: rep.month,
          sectorId: rep.sectorId,
          currency: rep.currency,
          fxRate: rep.fxRatePerWcu,
          gdpWcu: rep.gdpWcu,
          invariantValid: rep.invariants.valid,
          maxErrorMinor: maxErr.toString(),
        });
      }
    }

    // Close emergencies: responders on clear roads (V/C <= 1.2) resolve early; gridlocked or unattended ones cause damage
    const congested = this.ensureTraffic().congestedDispatches;
    for (let i = this.emergencies.length - 1; i >= 0; i--) {
      const emg = this.emergencies[i]!;
      const isGridlocked = congested.has(emg.instanceId);
      let resolveAt = emg.expiresAtGameSeconds;
      if (emg.attended && !isGridlocked && (emg.responders?.length ?? 0) > 0) {
        const arrival = Math.max(...emg.responders!.map((r) => r.arrivesAtGameSeconds));
        const onSiteSec = Math.round((ON_SITE_HOURS[emg.emergencyId] ?? 2) * 3600);
        resolveAt = Math.min(emg.expiresAtGameSeconds, arrival + Math.round(onSiteSec * 0.65));
      }
      if (resolveAt > this.totalGameSeconds) continue;
      this.emergencies.splice(i, 1);
      if (emg.emergencyId === "FROZEN_CONSTRUCTION" || emg.attended === undefined) continue;
      this.trafficDirty = true;
      const text =
        emg.attended && !isGridlocked
          ? `✅ Сектор ${emg.sectorId}: службы оперативно прибыли (V/C ≤ 1.2) и досрочно ликвидировали ЧП «${emg.titleRu.split(":")[0]}»`
          : this.applyEmergencyDamage(emg, isGridlocked);
      alerts.push(text);
      this.pushSystemChat(text);
    }

    if (this.trafficDirty) this.recomputeTraffic();
    return alerts;
  }

  private stepGameHours(hours: number): string[] {
    const alerts: string[] = [];
    // Advance building construction sites (unless stalled awaiting private 90% co-investors)
    for (const b of this.buildings.values()) {
      if (b.stalledAwaitingPrivate || b.constructionProgress >= 1) continue;
      const cat = this.catalogs.buildingsById.get(b.catalogId);
      const spec = MEGAPROJECT_SPECS[b.catalogId as MegaprojectCatalogId];
      const totalBuildHours = Math.max(1, cat?.buildTimeGameHours ?? spec?.buildTimeGameHours ?? 4);
      const nextProg = Math.min(1, b.constructionProgress + hours / totalBuildHours);
      if (nextProg !== b.constructionProgress) {
        const updated: BuildingDto = { ...b, constructionProgress: Number(nextProg.toFixed(3)) };
        this.buildings.set(b.id, updated);
        this.db.upsertBuilding(updated);
        if (nextProg >= 1) this.trafficDirty = true;
      }
    }

    // Timed factory/facility upgrades (sheet 22): the plant keeps running at its old level meanwhile
    for (const b of this.buildings.values()) {
      if (!b.upgradeTargetLevel) continue;
      const entry = this.catalogs.buildingsById.get(b.catalogId);
      const upgradeHours = entry
        ? computeBuildingAtLevel(entry, this.catalogs.levelCurves, b.upgradeTargetLevel).upgradeTimeGameHours
        : 0;
      const progress = upgradeHours > 0 ? (b.upgradeProgress ?? 0) + hours / upgradeHours : 1;
      const updated: BuildingDto =
        progress >= 1
          ? { ...b, level: b.upgradeTargetLevel, upgradeTargetLevel: null, upgradeProgress: 1 }
          : { ...b, upgradeProgress: Number(progress.toFixed(4)) };
      if (progress >= 1) {
        alerts.push(`🏗️ «${entry?.nameRu ?? b.catalogId}» #${b.id} вышел на Ур.${b.upgradeTargetLevel}`);
        this.trafficDirty = true;
      }
      this.buildings.set(b.id, updated);
      this.db.upsertBuilding(updated);
    }

    // Private developers build zones lot by lot, buying materials (GDD §6.1, sheet 20 Table 5)
    this.applyDeveloperMarket(hours);

    // Axle-load road wear from the live traffic flows (GDD §5.2), offset by the Road Service budget
    const wearBySegment = this.ensureTraffic().segmentWearPerHour;
    for (const seg of this.segments.values()) {
      if (seg.id.startsWith("GW-STUB-") || !isRoadKind(seg.kind)) continue;
      const wear = wearBySegment.get(seg.id) ?? 0;
      const level = this.roadServiceLevel.get(seg.sectorId) ?? 1;
      const restore = ROAD_SERVICE_RESTORE_PERCENT_PER_MONTH[level] / GAME_HOURS_PER_MONTH;
      const nextHealth = Math.max(
        MIN_ROAD_HEALTH_PERCENT,
        Math.min(100, Number((seg.healthPercent + (restore - wear) * hours).toFixed(3)))
      );
      if (nextHealth === seg.healthPercent) continue;
      const before = roadConditionStage(seg.healthPercent);
      const after = roadConditionStage(nextHealth);
      if (before !== after && nextHealth < seg.healthPercent) {
        alerts.push(
          after === "emergency"
            ? `🚧 Сектор ${seg.sectorId}: дорога ${seg.id} в аварийном состоянии (${nextHealth.toFixed(0)}%) — скорость −70%, нужен ремонт!`
            : `🚧 Сектор ${seg.sectorId}: на дороге ${seg.id} появились ямы и колеи (${nextHealth.toFixed(0)}%)`
        );
      }
      if (before !== after) this.trafficDirty = true;
      const updated: NetworkSegmentDto = { ...seg, healthPercent: nextHealth };
      this.segments.set(seg.id, updated);
      this.db.upsertSegment(updated);
    }
    return alerts;
  }

  // ---------------------------------------------------------------------------------------------
  // Sprint 4: developer construction market
  // ---------------------------------------------------------------------------------------------

  /** Whether each sector's starter gateway is linked to that sector's own road network. */
  private gatewayConnectivity(): Map<SectorId, boolean> {
    const graph = buildNetworkGraph([...this.segments.values()], "road");
    const labels = connectedComponents(graph);
    const result = new Map<SectorId, boolean>(SECTOR_IDS.map((s) => [s, false]));
    for (const gw of this.map.gateways) {
      const loc = locateOnGraph(graph, gw.tileX, gw.tileY, 14);
      if (!loc) continue;
      const comp = labels[graph.edges[loc.edgeId]!.a];
      const linked = graph.edges.some((e) => {
        if (labels[e.a] !== comp) return false;
        const seg = this.segments.get(e.segmentId);
        return !!seg && seg.sectorId === gw.sectorId && !seg.id.startsWith("GW-STUB-");
      });
      if (linked) result.set(gw.sectorId, true);
    }
    return result;
  }

  private runMarket(hours: number) {
    const gateways = this.gatewayConnectivity();
    return runDeveloperMarket({
      catalogs: this.catalogs,
      zones: [...this.zones.values()],
      buildings: [...this.buildings.values()],
      hours,
      districtHappiness: this.city ? new Map(this.city.districts.map((d) => [d.zoneId, d.happiness])) : undefined,
      plantOutputMultiplier: this.gas?.outputMultiplier,
      tradePartners: materialTradePartners(
        [...this.borderPosts.values()],
        new Set(this.borderStats.filter((st) => st.roadLinked).map((st) => st.postId))
      ),
      sectors: SECTOR_IDS.map((sectorId) => {
        const reg = this.engine.getRegion(sectorId);
        return {
          sectorId,
          happinessIndex: reg.happinessIndex,
          importDutyRate: reg.levers.importDutyRate,
          fxRatePerWcu: reg.fxRatePerWcu,
          gatewayConnected: gateways.get(sectorId) ?? false,
        };
      }),
    });
  }

  private applyDeveloperMarket(hours: number): void {
    const result = this.runMarket(hours);
    for (const z of result.zones) {
      const zone = this.zones.get(z.zoneId);
      if (!zone || z.occupancyAfter === z.occupancyBefore) continue;
      const updated: ZoneDto = { ...zone, occupancyRatio: Number(z.occupancyAfter.toFixed(4)) };
      this.zones.set(zone.id, updated);
      this.db.upsertZone(updated);
      if (z.dwellingsAdded > 0) this.engine.getRegion(zone.sectorId).dwellings += z.dwellingsAdded;
    }
    for (const sectorId of SECTOR_IDS) {
      const duty = result.importDutyBySector.get(sectorId) ?? 0n;
      const importCost = result.importCostExDutyBySector.get(sectorId) ?? 0n;
      if (importCost > 0n || duty > 0n) {
        this.engine.bookDeveloperMaterialImport(sectorId, importCost, duty);
      }
      if (duty > 0n) {
        this.engine.getRegion(sectorId).treasuryCashAtCb += duty;
        this.persistSectorState(sectorId);
      }
    }
    this.lastConstruction = {
      sectors: [...result.sectors],
      zoneSites: result.zones.map((z) => ({
        zoneId: z.zoneId,
        fillRatio: z.fillRatio,
        limitingMaterial: z.limitingMaterial,
      })),
    };
  }

  private constructionSnapshot() {
    if (!this.lastConstruction) {
      // Preview one hour of demand without building anything
      const preview = this.runMarket(1);
      return {
        sectors: [...preview.sectors],
        zoneSites: preview.zones.map((z) => ({ zoneId: z.zoneId, fillRatio: z.fillRatio, limitingMaterial: z.limitingMaterial })),
      };
    }
    return this.lastConstruction;
  }

  // ---------------------------------------------------------------------------------------------
  // Sprint 6: city services, emergencies & dispatch, car lifecycle, advisors
  // ---------------------------------------------------------------------------------------------

  private ensureCity(): CityModelResult {
    this.ensureTraffic();
    return this.city!;
  }

  /** Daily tick: car fleet flows and organic emergencies (one roll per elapsed day, last 30 at most). */
  private stepGameDays(firstDay: number, days: number): string[] {
    const alerts: string[] = [];
    const city = this.ensureCity();
    const transport = this.ensureTraffic().state.sectors;
    const households = new Map<SectorId, number>();
    const affluent = new Map<SectorId, number>();
    const roads = new Map<SectorId, number>();
    const damagedShare = new Map<SectorId, number>();
    for (const c of city.sectors) {
      households.set(c.sectorId, c.residents / 2.2);
      affluent.set(c.sectorId, c.residents > 0 ? ((c.residentsByTier[3] ?? 0) + (c.residentsByTier[4] ?? 0)) / c.residents : 0);
    }
    for (const t of transport) roads.set(t.sectorId, t.avgRoadHealth);
    for (const sid of SECTOR_IDS) {
      const segs = [...this.segments.values()].filter(
        (s) => s.sectorId === sid && !s.id.startsWith("GW-STUB-") && isRoadKind(s.kind)
      );
      const damaged = segs.filter((s) => s.healthPercent < 75).length;
      damagedShare.set(sid, segs.length > 0 ? damaged / segs.length : 0);
    }
    const monthFraction = days / 30;
    this.autoStats = runAutoMarket({
      catalogs: this.catalogs,
      fleets: [...this.fleets.values()],
      buildings: [...this.buildings.values()],
      households,
      affluentShare: affluent,
      avgRoadHealth: roads,
      damagedRoadShare: damagedShare,
      months: monthFraction,
    });
    const carStages = getCarStages();
    const stage2Price = carStages[1]?.marketPriceUnits ?? 14_500;
    for (const st of this.autoStats) {
      const reg = this.engine.getRegion(st.sectorId);
      const scale = monthFraction * reg.cpi * reg.fxRatePerWcu;
      const importedAutoSpend = st.newCarsImported
        ? money(st.newCarsPerMonth * st.newCarPriceUnits * scale)
        : 0n;
      const localNewSpend = !st.newCarsImported
        ? money(st.newCarsPerMonth * st.newCarPriceUnits * scale)
        : 0n;
      const usedTurnover = st.usedLot ? ((st.fleetByStage[1] ?? 0) + (st.fleetByStage[2] ?? 0)) * 0.08 : 0;
      const usedAndStoSpend = money(
        (usedTurnover * stage2Price + st.repairedPerMonth * AVERAGE_REPAIR_TICKET_UNITS) * scale
      );
      const scrapCredit = money(st.scrapRecycledTonsPerMonth * 420 * scale);
      this.engine.bookAutoMarketFlows({
        sectorId: st.sectorId,
        localAutoAndStoSpend: localNewSpend + usedAndStoSpend,
        importedAutoSpend,
        scrapSteelCredit: scrapCredit,
      });
    }
    for (const f of this.fleets.values()) {
      this.db.setMeta(`fleet:S${f.sectorId}`, JSON.stringify(f.fleet.map((v) => Number(v.toFixed(3)))));
    }

    for (let day = Math.max(firstDay, firstDay + days - 30); day < firstDay + days; day++) {
      const spawns = rollDailyEmergencies({
        catalogs: this.catalogs,
        worldId: this.worldId,
        gameDay: day,
        sectors: SECTOR_IDS.filter((s) => this.occupiedBySector.get(s)).map((sectorId) => {
          const reg = this.engine.getRegion(sectorId);
          const power = this.effectivePower(sectorId);
          const myPosts = [...this.borderPosts.values()].filter(
            (p) => p.sectorA === sectorId || p.sectorB === sectorId
          );
          const sanitaryQuarantine =
            myPosts.length > 0 && myPosts.every((p) => sideOf(p, sectorId)?.sanitaryQuarantine === true);
          const neighborContagionRisk = myPosts.some((p) => {
            const nb = p.sectorA === sectorId ? p.sectorB : p.sectorA;
            return this.emergencies.some(
              (e) =>
                e.sectorId === nb &&
                (e.emergencyId === "COAL_SMOG" || e.emergencyId === "RIVER_POLLUTION" || e.emergencyId === "GARBAGE_COLLAPSE")
            );
          });
          return {
            sectorId,
            activeDecreeIds: [...reg.levers.activeDecreeIds],
            hardshipShare: reg.hardshipShare,
            annualInflation: reg.lastReport?.annualInflation ?? 0.03,
            powerDeficit: power.supplyMw < power.demandMw,
            sanitaryQuarantine,
            neighborContagionRisk,
          };
        }),
        buildings: [...this.buildings.values()],
        zones: [...this.zones.values()],
        segments: [...this.segments.values()],
        districts: city.districts,
        active: this.emergencies,
      });
      for (const sp of spawns) alerts.push(this.spawnEmergency(sp));
    }

    // Border queues beyond two hours become the KPP blockade emergency (GDD §6.6 #10)
    for (const st of this.borderStats) {
      const post = this.borderPosts.get(st.postId);
      if (!post || !isBlockaded(st)) continue;
      if (this.emergencies.some((e) => e.emergencyId === "KPP_BLOCKADE" && e.targetRef === post.id)) continue;
      alerts.push(
        this.spawnEmergency({
          emergencyId: "KPP_BLOCKADE",
          sectorId: post.sectorA,
          tileX: Math.round(post.tileX + post.width / 2),
          tileY: Math.round(post.tileY + post.depth / 2),
          targetRef: post.id,
          causeRu: `очередь фур ${st.queueMinutes} мин при пропускной ${st.capacityTrucksPerHour} фур/ч`,
        })
      );
    }

    alerts.push(...this.runAiGovernors());
    return alerts;
  }

  // ---------------------------------------------------------------------------------------------
  // Sprint 7: border posts, gas & power ring, megaprojects, exchange, AI governor
  // ---------------------------------------------------------------------------------------------

  private roadLinks() {
    const stats = new Map(this.borderStats.map((s) => [s.postId, s]));
    return borderLinks([...this.borderPosts.values()], this.segments.values(), ["street_2lane", "avenue_4lane", "express_6lane", "heavy_bypass"], (post) =>
      (stats.get(post.id)?.queueMinutes ?? 0) / 60
    );
  }

  /** Pipelines and HV lines join through posts only while the hydrocarbon lane and gas valves are open both ways. */
  private utilityLinks(kind: "pipeline" | "hv_power") {
    const open = [...this.borderPosts.values()].filter((p) => {
      const a = p.sides[0]!;
      const b = p.sides[1]!;
      return kind === "hv_power"
        ? a.visaRegime !== "closed" && b.visaRegime !== "closed"
        : laneOpen(a, b, "hydrocarbons") &&
            laneOpen(b, a, "hydrocarbons") &&
            a.gasValveOpen !== false &&
            b.gasValveOpen !== false;
    });
    return borderLinks(open, this.segments.values(), [kind]);
  }

  private postLevel(postId: string): number {
    return this.buildings.get(postId)?.level ?? 1;
  }

  private persistTakeovers(): void {
    this.db.setMeta("pendingTakeovers", JSON.stringify(this.pendingTakeovers));
  }

  private persistMegaResources(): void {
    this.db.setMeta("megaResources", JSON.stringify([...this.megaResources]));
  }

  private applyDueTakeovers(): string[] {
    const alerts: string[] = [];
    for (let i = this.pendingTakeovers.length - 1; i >= 0; i--) {
      const tk = this.pendingTakeovers[i]!;
      if (tk.effectiveAtGameSeconds > this.totalGameSeconds) continue;
      this.pendingTakeovers.splice(i, 1);
      const b = this.buildings.get(tk.buildingId);
      if (!b) continue;
      let stake = this.foreignStakes.find((f) => f.buildingId === b.id && f.holderSector === tk.bidderSectorId);
      if (!stake) {
        stake = { buildingId: b.id, holderSector: tk.bidderSectorId, share: 0 };
        this.foreignStakes.push(stake);
      }
      stake.share = Number(Math.min(1 - b.cityEquityShare, stake.share + tk.deltaShare).toFixed(4));
      this.db.upsertEquityStake(b.id, tk.bidderSectorId, stake.share);
      const homeReg = this.engine.getRegion(tk.targetSectorId);
      const homeLocal = mulRate(BigInt(tk.bidPriceWcuMinor), homeReg.fxRatePerWcu);
      this.engine.bookLedgerEntry(tk.targetSectorId, [
        "Foreign takeover settlement (World -> Fk)",
        0n,
        0n,
        homeLocal,
        0n,
        0n,
        0n,
        -homeLocal,
      ]);
      alerts.push(
        `📈 Завершено поглощение: Сектор ${tk.bidderSectorId} консолидировал ${(stake.share * 100).toFixed(1)}% «${tk.companyNameRu}» (Сектор ${tk.targetSectorId})`
      );
      this.trafficDirty = true;
    }
    if (alerts.length > 0) this.persistTakeovers();
    return alerts;
  }

  private applyDueBorderChanges(): string[] {
    const alerts: string[] = [];
    for (const post of this.borderPosts.values()) {
      const due = post.pending.filter((c) => c.effectiveAtGameSeconds <= this.totalGameSeconds);
      if (due.length === 0) continue;
      let sides = [...post.sides];
      for (const change of due) {
        sides = sides.map((sd) => (sd.sectorId === change.sectorId ? change.policy : sd));
        alerts.push(`🛂 КПП #${post.id}: вступила в силу мера Сектора ${change.sectorId} — ${describePolicy(change.policy)}`);
      }
      const updated: BorderPostDto = { ...post, sides, pending: post.pending.filter((c) => !due.includes(c)) };
      this.borderPosts.set(post.id, updated);
      this.db.upsertBorderPost(updated);
      this.trafficDirty = true;
    }
    return alerts;
  }

  private handleSetBorderPolicy(cmd: Extract<ClientCommand, { type: "set_border_policy" }>): CommandOutcome {
    const post = this.borderPosts.get(cmd.postId);
    const current = post ? sideOf(post, cmd.sectorId) : undefined;
    if (!post || !current) return { ok: false, message: "Этот КПП не на границе вашего сектора" };
    this.engine.getRegion(cmd.sectorId).lastMayorActivityEpochMs = Date.now();

    const clampDuty = (v: number) => Math.max(0, Math.min(2, Math.round(v * 1000) / 1000));
    const importDuty = { ...current.importDuty };
    const exportDuty = { ...current.exportDuty };
    const transitDuty = {
      raw: current.transitDuty?.raw ?? 0.03,
      hydrocarbons: current.transitDuty?.hydrocarbons ?? 0.03,
      agri: current.transitDuty?.agri ?? 0.03,
      manufactured: current.transitDuty?.manufactured ?? 0.03,
      luxury: current.transitDuty?.luxury ?? 0.03,
    };
    for (const lane of CARGO_LANES) {
      const imp = cmd.importDuty?.[lane];
      const exp = cmd.exportDuty?.[lane];
      const trn = cmd.transitDuty?.[lane];
      if (imp !== undefined) importDuty[lane] = clampDuty(imp);
      if (exp !== undefined) exportDuty[lane] = clampDuty(exp);
      if (trn !== undefined) transitDuty[lane] = clampDuty(trn);
    }
    const next: BorderSidePolicyDto = {
      sectorId: cmd.sectorId,
      visaRegime: cmd.visaRegime ?? current.visaRegime,
      importDuty,
      exportDuty,
      transitDuty,
      embargo: cmd.embargo ? [...new Set(cmd.embargo.filter((l) => CARGO_LANES.includes(l)))] : current.embargo,
      inspection: cmd.inspection ?? current.inspection,
      sanitaryQuarantine: cmd.sanitaryQuarantine ?? current.sanitaryQuarantine ?? false,
      gasValveOpen: cmd.gasValveOpen ?? current.gasValveOpen ?? true,
    };
    const neighbor = post.sectorA === cmd.sectorId ? post.sectorB : post.sectorA;
    const days = noticeDaysFor(current, next);
    if (days === 0) {
      const updated: BorderPostDto = {
        ...post,
        sides: post.sides.map((sd) => (sd.sectorId === cmd.sectorId ? next : sd)),
        pending: post.pending.filter((c) => c.sectorId !== cmd.sectorId),
      };
      this.borderPosts.set(post.id, updated);
      this.db.upsertBorderPost(updated);
      this.recomputeTraffic();
      return { ok: true, message: `КПП #${post.id}: режим Сектора ${cmd.sectorId} обновлён (${describePolicy(next)})` };
    }
    // Hostile move: notice window, the neighbour is warned at once (GDD §1.4)
    const effectiveAt = this.totalGameSeconds + days * 86_400;
    // Sanitary quarantine and gas valve apply immediately even when tariffs wait for notice window
    const immediateSide: BorderSidePolicyDto = {
      ...current,
      sanitaryQuarantine: next.sanitaryQuarantine,
      gasValveOpen: next.gasValveOpen,
    };
    const descriptionRu = `Сектор ${cmd.sectorId} на КПП #${post.id} вводит: ${describePolicy(next)} — через ${days} игр. дн.`;
    const updated: BorderPostDto = {
      ...post,
      sides: post.sides.map((sd) => (sd.sectorId === cmd.sectorId ? immediateSide : sd)),
      pending: [...post.pending.filter((c) => c.sectorId !== cmd.sectorId), { sectorId: cmd.sectorId, effectiveAtGameSeconds: effectiveAt, descriptionRu, policy: next }],
    };
    this.borderPosts.set(post.id, updated);
    this.db.upsertBorderPost(updated);
    this.recomputeTraffic();
    this.pushSystemChat(`⚠️ ОКНО УВЕДОМЛЕНИЯ для Сектора ${neighbor}: ${descriptionRu}`);
    return { ok: true, message: descriptionRu, noticeAlerts: [descriptionRu] };
  }

  private handleSetGasValve(cmd: Extract<ClientCommand, { type: "set_gas_valve" }>): CommandOutcome {
    const post = this.borderPosts.get(cmd.postId);
    const current = post ? sideOf(post, cmd.sectorId) : undefined;
    if (!post || !current) return { ok: false, message: "Этот КПП не на границе вашего сектора" };
    this.engine.getRegion(cmd.sectorId).lastMayorActivityEpochMs = Date.now();
    const neighbor = post.sectorA === cmd.sectorId ? post.sectorB : post.sectorA;
    const nextSide: BorderSidePolicyDto = { ...current, gasValveOpen: cmd.open };
    const updated: BorderPostDto = {
      ...post,
      sides: post.sides.map((sd) => (sd.sectorId === cmd.sectorId ? nextSide : sd)),
    };
    this.borderPosts.set(post.id, updated);
    this.db.upsertBorderPost(updated);
    this.recomputeTraffic();
    const alert = cmd.open
      ? `🔥 КПП #${post.id}: Сектор ${cmd.sectorId} открыл газовый вентиль — прокачка в Сектор ${neighbor} возобновлена`
      : `🔥 ЭКСТРЕННЫЙ ВЕНТИЛЬ КПП #${post.id}: Сектор ${cmd.sectorId} перекрыл подачу газа Сектору ${neighbor}! Импортёр теряет бонус +40%, ПГУ переведены на резервный мазут (45% МВт).`;
    this.pushSystemChat(alert);
    return { ok: true, message: alert, noticeAlerts: [alert] };
  }

  private megaprojectList(): MegaprojectDto[] {
    const stakes = [...this.megaStakes.values()];
    return [...this.buildings.values()]
      .filter((b) => b.catalogId.startsWith("MEG-"))
      .map((b) => megaprojectStatus(b, this.catalogs, stakes, this.megaResources.get(b.id)));
  }

  private handleFoundMegaproject(cmd: Extract<ClientCommand, { type: "found_megaproject" }>): CommandOutcome {
    const spec = MEGAPROJECT_SPECS[cmd.catalogId];
    if (!spec) return { ok: false, message: `Неизвестный мегапроект ${cmd.catalogId}` };
    if ([...this.buildings.values()].some((b) => b.catalogId === cmd.catalogId)) {
      return { ok: false, message: `«${spec.nameRu}» уже заложен в Центральном Ядре — внесите вклад в стройку` };
    }
    const reg = this.engine.getRegion(cmd.sectorId);
    reg.lastMayorActivityEpochMs = Date.now();
    reg.isAiGovernor = false;

    const padFree = (px: number, py: number, pw: number, pd: number): boolean => {
      for (let dy = 0; dy < pd; dy++) {
        for (let dx = 0; dx < pw; dx++) {
          const tx = px + dx;
          const ty = py + dy;
          const idx = ty * this.map.width + tx;
          if (this.map.owner[idx] !== OwnerCode.CentralCore || this.map.surface[idx] !== SurfaceType.Land) {
            return false;
          }
        }
      }
      for (const ex of this.buildings.values()) {
        if (px < ex.tileX + ex.width && px + pw > ex.tileX && py < ex.tileY + ex.depth && py + pd > ex.tileY) {
          return false;
        }
      }
      return true;
    };

    let { tileX, tileY, width, depth } = spec.corePad;
    if (!padFree(tileX, tileY, width, depth)) {
      width = 14;
      depth = 14;
      let found = false;
      for (let sy = 450; sy <= 536 && !found; sy += 4) {
        for (let sx = 450; sx <= 536 && !found; sx += 4) {
          if (padFree(sx, sy, width, depth)) {
            tileX = sx;
            tileY = sy;
            found = true;
          }
        }
      }
      if (!found) return { ok: false, message: "В Центральном Ядре (500, 500) не осталось свободной площадки" };
    }

    const bld: BuildingDto = {
      id: this.nextId("bld"),
      catalogId: cmd.catalogId,
      sectorId: "core",
      tileX,
      tileY,
      width,
      depth,
      orientationDeg: 0,
      level: 1,
      constructionProgress: 0,
      cityEquityShare: 0,
      stalledAwaitingPrivate: true,
    };
    this.buildings.set(bld.id, bld);
    this.db.upsertBuilding(bld);
    this.pushSystemChat(
      `🌐 Сектор ${cmd.sectorId} заложил кооперативный мегапроект «${spec.nameRu}» в Центральном Ядре (500, 500) — открыт приём караванов и траншей МРЕ!`
    );
    return {
      ok: true,
      message: `Заложен мегапроект «${spec.nameRu}» (${formatMoney(spec.costWcuMinor)} МРЕ). Отправляйте караваны стройматериалов или транши МРЕ!`,
    };
  }

  private handleContributeMegaproject(cmd: Extract<ClientCommand, { type: "contribute_megaproject" }>): CommandOutcome {
    const b = this.buildings.get(cmd.buildingId);
    if (!b || !b.catalogId.startsWith("MEG-")) return { ok: false, message: "Мегапроект не найден" };
    const status = megaprojectStatus(b, this.catalogs, [...this.megaStakes.values()], this.megaResources.get(b.id));
    const remaining = BigInt(status.costWcuMinor) - BigInt(status.fundedWcuMinor);
    if (remaining <= 0n) return { ok: false, message: "Мегапроект уже полностью профинансирован" };

    const reg = this.engine.getRegion(cmd.sectorId);
    reg.lastMayorActivityEpochMs = Date.now();
    let amount = money(Math.max(0, cmd.amountUnits));
    let caravanNote = "";
    let shippedTons = 0;

    if (cmd.caravanCommodity && (cmd.caravanTons ?? 0) > 0) {
      const req = status.requiredResources?.[cmd.caravanCommodity] ?? 0;
      const deliv = status.deliveredResources?.[cmd.caravanCommodity] ?? 0;
      shippedTons = Math.min(Math.round(cmd.caravanTons!), Math.max(100, req - deliv));
      const unitWcu =
        this.catalogs.commoditiesByName.get(cmd.caravanCommodity)?.worldReferencePriceUnits ??
        (cmd.caravanCommodity === "Microchips"
          ? 12_500
          : cmd.caravanCommodity === "Industrial Machinery"
            ? 6_800
            : cmd.caravanCommodity === "Steel"
              ? 520
              : 140);
      // Megaproject engineering contract value per ton (includes heavy core transport & installation)
      amount = money(shippedTons * unitWcu * 8);
      caravanNote = `караван ${shippedTons.toLocaleString("ru-RU")} т «${MEGAPROJECT_RESOURCE_NAMES_RU[cmd.caravanCommodity]}» `;
    }

    if (amount <= 0n) return { ok: false, message: "Укажите сумму взноса в МРЕ или объём каравана" };
    if (amount > remaining) amount = remaining;

    const local = mulRate(amount, reg.fxRatePerWcu);
    if (cmd.source === "swf") {
      if (reg.swfBalanceWcu < amount) {
        return { ok: false, message: `В Фонде благосостояния только ${formatMoney(reg.swfBalanceWcu)} МРЕ` };
      }
      reg.swfBalanceWcu -= amount;
    } else {
      if (reg.treasuryCashAtCb < local) {
        return { ok: false, message: `Недостаточно средств казны: нужно ${fmtSym(local, currencySymbol(reg.currency))}` };
      }
      reg.treasuryCashAtCb -= local;
      const hasLocalPlant =
        Boolean(cmd.caravanCommodity) &&
        [...this.buildings.values()].some((pb) => {
          if (pb.sectorId !== cmd.sectorId || pb.constructionProgress < 1 || pb.stalledAwaitingPrivate) return false;
          return this.catalogs.buildingsById.get(pb.catalogId)?.mainOutput === cmd.caravanCommodity;
        });
      if (hasLocalPlant) {
        this.engine.bookLedgerEntry(cmd.sectorId, [
          "Megaproject domestic caravan procurement (T -> Fc)",
          0n,
          local,
          0n,
          -local,
          0n,
          0n,
          0n,
        ]);
        this.engine.bookLedgerEntry(cmd.sectorId, [
          "Megaproject caravan shipment to Core (Fc -> World)",
          0n,
          -local,
          0n,
          0n,
          0n,
          0n,
          local,
        ]);
      } else {
        this.engine.bookLedgerEntry(cmd.sectorId, [
          "Megaproject capital contribution (T -> World)",
          0n,
          0n,
          0n,
          -local,
          0n,
          0n,
          local,
        ]);
      }
    }

    if (cmd.caravanCommodity && shippedTons > 0) {
      const cur = { ...(this.megaResources.get(b.id) ?? {}) };
      cur[cmd.caravanCommodity] = (cur[cmd.caravanCommodity] ?? 0) + shippedTons;
      this.megaResources.set(b.id, cur);
      this.persistMegaResources();
    }

    const key = `${b.id}|${cmd.sectorId}`;
    const prev = this.megaStakes.get(key)?.contributedWcu ?? 0n;
    const rec: MegaprojectStakeRecord = { buildingId: b.id, sectorId: cmd.sectorId, contributedWcu: prev + amount };
    this.megaStakes.set(key, rec);
    this.db.upsertMegaprojectStake(b.id, cmd.sectorId, rec.contributedWcu.toString());
    this.persistSectorState(cmd.sectorId);

    const after = megaprojectStatus(b, this.catalogs, [...this.megaStakes.values()], this.megaResources.get(b.id));
    if (after.status !== "funding" && b.stalledAwaitingPrivate) {
      const started: BuildingDto = { ...b, stalledAwaitingPrivate: false };
      this.buildings.set(b.id, started);
      this.db.upsertBuilding(started);
      this.pushSystemChat(`🏗️ Мегапроект «${after.nameRu}» профинансирован: стройка в Центральном Ядре началась!`);
    }
    const share = after.stakes.find((st) => st.sectorId === cmd.sectorId)?.share ?? 0;
    return {
      ok: true,
      message: `Взнос ${caravanNote}(${formatMoney(amount)} МРЕ) в «${after.nameRu}» (${cmd.source === "swf" ? "из Фонда" : "из казны"}). Доля Сектора ${cmd.sectorId}: ${(share * 100).toFixed(1)}%`,
    };
  }

  private listedCompanies(): ListedCompanyDto[] {
    const exchanges = new Set(
      [...this.buildings.values()]
        .filter((b) => b.catalogId === "FIN-02" && b.constructionProgress >= 1)
        .map((b) => b.sectorId)
    );
    const anyExchangeOpen = exchanges.size > 0;
    const out: ListedCompanyDto[] = [];
    for (const b of this.buildings.values()) {
      if (b.sectorId === "core" || !isListable(b.catalogId)) continue;
      const isStalledCoInvested = b.stalledAwaitingPrivate;
      if (!isStalledCoInvested && b.constructionProgress < 1) continue;
      if (!isStalledCoInvested && !anyExchangeOpen && !exchanges.has(b.sectorId)) {
        // Still list Tier 2-4 co-invested enterprises across all 5 sectors for board visibility & SPO/buyout
        const cat = this.catalogs.buildingsById.get(b.catalogId);
        if (cat?.ownershipContour !== "co_invested_10_90") continue;
      }
      const reg = this.engine.getRegion(b.sectorId);
      out.push(
        valueListedCompany({
          catalogs: this.catalogs,
          building: b,
          fxRatePerWcu: reg.fxRatePerWcu,
          keyRate: reg.levers.keyRate,
          expectedRoi: reg.factories.find((f) => f.projectId === b.id)?.expectedAnnualRoi,
          foreignStakes: this.foreignStakes,
        })
      );
    }
    return out;
  }

  private handleTradeStake(cmd: Extract<ClientCommand, { type: "trade_stake" }>): CommandOutcome {
    const b = this.buildings.get(cmd.buildingId);
    if (b && b.stalledAwaitingPrivate && b.sectorId === cmd.sectorId && cmd.deltaShare > 0) {
      return this.handleBuyoutFactory(cmd.sectorId, cmd.buildingId);
    }
    const exchanges = new Set(
      [...this.buildings.values()]
        .filter((x) => x.catalogId === "FIN-02" && x.constructionProgress >= 1)
        .map((x) => x.sectorId)
    );
    const company = this.listedCompanies().find((c) => c.buildingId === cmd.buildingId);
    if (!company || !b) {
      return { ok: false, message: "Компания не котируется: постройте Биржевую площадку FIN-02" };
    }
    if (company.stalledAwaitingPrivate) {
      return { ok: false, message: "Завод заморожен на этапе стройки — выкупить 100% долю может мэр его сектора" };
    }
    if (company.sectorId !== cmd.sectorId && exchanges.size === 0) {
      return { ok: false, message: "Для трансграничных сделок с акциями нужна построенная Биржа FIN-02" };
    }
    const delta = Math.round(Math.max(-1, Math.min(1, cmd.deltaShare)) * 10_000) / 10_000;
    if (delta === 0) return { ok: false, message: "Укажите долю для сделки" };
    const buyer = this.engine.getRegion(cmd.sectorId);
    buyer.lastMayorActivityEpochMs = Date.now();
    const home = this.engine.getRegion(company.sectorId);
    const valueHome = mulRate(BigInt(company.marketCapLocalMinor), Math.abs(delta));
    const valueWcu = mulRate(valueHome, 1 / home.fxRatePerWcu);
    const buyerLocal = mulRate(valueWcu, buyer.fxRatePerWcu);
    const pct = `${(Math.abs(delta) * 100).toFixed(1)}%`;

    const pay = (): string | null => {
      if (cmd.source === "swf") {
        if (buyer.swfBalanceWcu < valueWcu) return `В Фонде благосостояния недостаточно МРЕ (нужно ${formatMoney(valueWcu)})`;
        buyer.swfBalanceWcu -= valueWcu;
      } else {
        if (buyer.treasuryCashAtCb < buyerLocal) {
          return `Недостаточно средств казны (нужно ${fmtSym(buyerLocal, currencySymbol(buyer.currency))})`;
        }
        buyer.treasuryCashAtCb -= buyerLocal;
      }
      return null;
    };
    const receive = () => {
      if (cmd.source === "swf") buyer.swfBalanceWcu += valueWcu;
      else buyer.treasuryCashAtCb += buyerLocal;
    };

    if (company.sectorId === cmd.sectorId) {
      // Own plant: buy back private shares (T -> Fk) or SPO privatise part of city's stake (Fk -> T)
      if (delta > 0 && company.privateShare < delta) return { ok: false, message: `У частных инвесторов только ${(company.privateShare * 100).toFixed(1)}%` };
      if (delta < 0 && company.cityShare < -delta) return { ok: false, message: `У города только ${(company.cityShare * 100).toFixed(1)}%` };
      if (delta > 0) {
        const err = pay();
        if (err) return { ok: false, message: err };
        if (cmd.source === "treasury") {
          this.engine.bookLedgerEntry(cmd.sectorId, [
            "Stock exchange municipal buyout (T -> Fk)",
            0n,
            0n,
            buyerLocal,
            -buyerLocal,
            0n,
            0n,
            0n,
          ]);
        }
      } else {
        receive();
        if (cmd.source === "treasury") {
          this.engine.bookLedgerEntry(cmd.sectorId, [
            "SPO municipal privatization (Fk -> T)",
            0n,
            0n,
            -buyerLocal,
            buyerLocal,
            0n,
            0n,
            0n,
          ]);
        }
      }
      const cityShare = Math.max(0, Math.min(1, b.cityEquityShare + delta));
      const updated: BuildingDto = { ...b, cityEquityShare: Number(cityShare.toFixed(4)) };
      this.buildings.set(b.id, updated);
      this.db.upsertBuilding(updated);
      const proj = home.factories.find((f) => f.projectId === b.id);
      if (proj) {
        proj.cityShare = updated.cityEquityShare;
        proj.privateShare = Math.max(0, 1 - updated.cityEquityShare);
      }
      this.persistSectorState(cmd.sectorId);
      return {
        ok: true,
        message:
          delta > 0
            ? `Мэрия выкупила ${pct} «${company.nameRu}» у частных инвесторов (доля города ${(cityShare * 100).toFixed(1)}%)`
            : `SPO Приватизация: ${pct} «${company.nameRu}» продано частному капиталу Fk за ${fmtSym(buyerLocal, currencySymbol(buyer.currency))}`,
      };
    }

    // A neighbour's plant: buy from private investors or sell the stake back
    let stake = this.foreignStakes.find((f) => f.buildingId === b.id && f.holderSector === cmd.sectorId);
    const pendingAll = this.pendingTakeovers
      .filter((t) => t.buildingId === b.id)
      .reduce((s, t) => s + t.deltaShare, 0);
    const pendingMine = this.pendingTakeovers
      .filter((t) => t.buildingId === b.id && t.bidderSectorId === cmd.sectorId)
      .reduce((s, t) => s + t.deltaShare, 0);
    const freeFloat = Math.max(0, company.privateShare - pendingAll);
    if (delta > 0 && freeFloat < delta) {
      return { ok: false, message: `В свободном обращении только ${(freeFloat * 100).toFixed(1)}%` };
    }
    if (delta < 0 && (stake?.share ?? 0) < -delta) return { ok: false, message: "У вас нет такой доли" };

    if (delta > 0) {
      const err = pay();
      if (err) return { ok: false, message: err };
      if (cmd.source === "treasury") {
        this.engine.bookLedgerEntry(cmd.sectorId, [
          "Cross-border equity purchase (T -> World)",
          0n,
          0n,
          0n,
          -buyerLocal,
          0n,
          0n,
          buyerLocal,
        ]);
      }
      const resultingShare = Number(((stake?.share ?? 0) + pendingMine + delta).toFixed(4));
      if (resultingShare > FOREIGN_TAKEOVER_NOTICE_THRESHOLD) {
        const tk: PendingTakeoverDto = {
          id: this.nextId("tk"),
          buildingId: b.id,
          companyNameRu: company.nameRu,
          targetSectorId: company.sectorId,
          bidderSectorId: cmd.sectorId,
          deltaShare: delta,
          resultingShare,
          bidPriceWcuMinor: valueWcu.toString(),
          source: cmd.source,
          effectiveAtGameSeconds: this.totalGameSeconds + FOREIGN_TAKEOVER_NOTICE_DAYS * 86_400,
        };
        this.pendingTakeovers.push(tk);
        this.persistTakeovers();
        this.persistSectorState(cmd.sectorId);
        const alert = `⚠️ ОКНО УВЕДОМЛЕНИЯ О ПОГЛОЩЕНИИ: Сектор ${cmd.sectorId} скупает ${pct} «${company.nameRu}» (итого ${(resultingShare * 100).toFixed(1)}% > 25%). У Мэрии Сектора ${company.sectorId} есть ${FOREIGN_TAKEOVER_NOTICE_DAYS} игр. дн. на преимущественный выкуп!`;
        this.pushSystemChat(alert);
        return { ok: true, message: alert, noticeAlerts: [alert] };
      }
      this.engine.bookLedgerEntry(company.sectorId, [
        "Foreign portfolio inflow (World -> Fk)",
        0n,
        0n,
        valueHome,
        0n,
        0n,
        0n,
        -valueHome,
      ]);
    } else {
      receive();
      if (cmd.source === "treasury") {
        this.engine.bookLedgerEntry(cmd.sectorId, [
          "Cross-border equity sale (World -> T)",
          0n,
          0n,
          0n,
          buyerLocal,
          0n,
          0n,
          -buyerLocal,
        ]);
      }
      this.engine.bookLedgerEntry(company.sectorId, [
        "Foreign portfolio outflow (Fk -> World)",
        0n,
        0n,
        -valueHome,
        0n,
        0n,
        0n,
        valueHome,
      ]);
    }
    if (!stake) {
      stake = { buildingId: b.id, holderSector: cmd.sectorId, share: 0 };
      this.foreignStakes.push(stake);
    }
    stake.share = Number(Math.max(0, stake.share + delta).toFixed(4));
    this.db.upsertEquityStake(b.id, cmd.sectorId, stake.share);
    this.persistSectorState(cmd.sectorId);
    return {
      ok: true,
      message: `${delta > 0 ? "Куплено" : "Продано"} ${pct} «${company.nameRu}» (Сектор ${company.sectorId}) за ${formatMoney(valueWcu)} МРЕ ${cmd.source === "swf" ? "из Фонда" : "через казну"}`,
    };
  }

  private handlePreemptTakeover(cmd: Extract<ClientCommand, { type: "preempt_takeover" }>): CommandOutcome {
    const idx = this.pendingTakeovers.findIndex((t) => t.id === cmd.takeoverId);
    if (idx < 0) return { ok: false, message: "Оферта на поглощение не найдена или уже исполнена" };
    const tk = this.pendingTakeovers[idx]!;
    if (tk.targetSectorId !== cmd.sectorId) {
      return { ok: false, message: "Право преимущественного выкупа принадлежит только мэру домашнего сектора" };
    }
    const b = this.buildings.get(tk.buildingId);
    if (!b) return { ok: false, message: "Предприятие не найдено" };

    const homeReg = this.engine.getRegion(cmd.sectorId);
    homeReg.lastMayorActivityEpochMs = Date.now();
    const bidWcu = BigInt(tk.bidPriceWcuMinor);
    const homeLocal = mulRate(bidWcu, homeReg.fxRatePerWcu);
    if (cmd.source === "swf") {
      if (homeReg.swfBalanceWcu < bidWcu) {
        return { ok: false, message: `В Фонде благосостояния недостаточно МРЕ (нужно ${formatMoney(bidWcu)})` };
      }
      homeReg.swfBalanceWcu -= bidWcu;
    } else {
      if (homeReg.treasuryCashAtCb < homeLocal) {
        return {
          ok: false,
          message: `Недостаточно средств казны на защитный выкуп (нужно ${fmtSym(homeLocal, currencySymbol(homeReg.currency))})`,
        };
      }
      homeReg.treasuryCashAtCb -= homeLocal;
      this.engine.bookLedgerEntry(cmd.sectorId, [
        "Right-of-first-refusal buyout (T -> Fk)",
        0n,
        0n,
        homeLocal,
        -homeLocal,
        0n,
        0n,
        0n,
      ]);
    }

    // Refund the foreign bidder's escrowed funds
    const bidderReg = this.engine.getRegion(tk.bidderSectorId);
    if (tk.source === "swf") {
      bidderReg.swfBalanceWcu += bidWcu;
    } else {
      const bidderLocal = mulRate(bidWcu, bidderReg.fxRatePerWcu);
      bidderReg.treasuryCashAtCb += bidderLocal;
      this.engine.bookLedgerEntry(tk.bidderSectorId, [
        "Refunded takeover escrow (World -> T)",
        0n,
        0n,
        0n,
        bidderLocal,
        0n,
        0n,
        -bidderLocal,
      ]);
    }
    this.persistSectorState(tk.bidderSectorId);

    const cityShare = Math.min(1, Number((b.cityEquityShare + tk.deltaShare).toFixed(4)));
    const updated: BuildingDto = { ...b, cityEquityShare: cityShare };
    this.buildings.set(b.id, updated);
    this.db.upsertBuilding(updated);
    const proj = homeReg.factories.find((f) => f.projectId === b.id);
    if (proj) {
      proj.cityShare = cityShare;
      proj.privateShare = Math.max(0, 1 - cityShare);
    }
    this.pendingTakeovers.splice(idx, 1);
    this.persistTakeovers();
    this.persistSectorState(cmd.sectorId);

    const alert = `🛡️ Защита суверенитета: Сектор ${cmd.sectorId} перекупил ${(tk.deltaShare * 100).toFixed(1)}% «${tk.companyNameRu}» по праву первой руки, отклонив поглощение Сектором ${tk.bidderSectorId}!`;
    this.pushSystemChat(alert);
    return { ok: true, message: alert, noticeAlerts: [alert] };
  }

  /** Power balance of a sector before the ring: generators (gas turbines need gas), fusion share. */
  private basePower(sectorId: SectorId): { supplyMw: number; demandMw: number } {
    const p = this.computeSectorPower(sectorId);
    const fusion = fusionPowerShares(this.megaprojectList()).get(sectorId) ?? 0;
    return { supplyMw: Math.round((p.supplyMw + fusion) * 10) / 10, demandMw: p.demandMw };
  }

  private powerRing(): SectorPowerRingDto[] {
    return runPowerRing({
      segments: [...this.segments.values()],
      links: this.utilityLinks("hv_power"),
      supplyDemand: new Map(SECTOR_IDS.map((s) => [s, this.basePower(s)])),
    });
  }

  /** Supply after ring imports/exports — what blackouts and advisors look at. */
  private effectivePower(sectorId: SectorId): { supplyMw: number; demandMw: number } {
    const ring = this.powerRing().find((r) => r.sectorId === sectorId)!;
    return { supplyMw: Math.round((ring.supplyMw + ring.importedMw - ring.exportedMw) * 10) / 10, demandMw: ring.demandMw };
  }

  /**
   * One game month of cross-border money for a sector (local minor units): customs & visa revenue,
   * power-ring and gas trade, emergency fuel-oil burn, megaproject and foreign-stake dividends,
   * booked into `RegionalMoneyEngine` with `SUM(row) == 0n`.
   */
  private bookAndComputeMonthlyGeopolitics(sectorId: SectorId): Money {
    const reg = this.engine.getRegion(sectorId);
    let total = 0n;
    let dutySum = 0n;
    let visaSum = 0n;
    for (const st of this.borderStats) {
      const rev = st.revenue.find((r) => r.sectorId === sectorId);
      if (rev) {
        dutySum += BigInt(rev.dutyMinor);
        visaSum += BigInt(rev.visaMinor);
      }
    }
    if (dutySum > 0n) {
      total += dutySum;
      this.engine.bookLedgerEntry(sectorId, [
        "Border KPP customs & transit duties (Fc -> T)",
        0n,
        -dutySum,
        0n,
        dutySum,
        0n,
        0n,
        0n,
      ]);
    }
    if (visaSum > 0n) {
      total += visaSum;
      this.engine.bookLedgerEntry(sectorId, [
        "Border KPP visa fees (World -> T)",
        0n,
        0n,
        0n,
        visaSum,
        0n,
        0n,
        -visaSum,
      ]);
    }

    // Power ring: importers pay +20% over wholesale; exporters receive it (720 h a month)
    const ring = this.powerRing().find((r) => r.sectorId === sectorId);
    const mwhPrice = wholesalePowerPricePerMwh() * (1 + POWER_RING_PREMIUM);
    if (ring) {
      const netMw = ring.exportedMw - ring.importedMw;
      const powerLocal = mulRate(money(mwhPrice * 720 * Math.abs(netMw)), reg.fxRatePerWcu);
      if (netMw > 0 && powerLocal > 0n) {
        total += powerLocal;
        this.engine.bookLedgerEntry(sectorId, [
          "HV power ring surplus export (World -> T)",
          0n,
          0n,
          0n,
          powerLocal,
          0n,
          0n,
          -powerLocal,
        ]);
      } else if (netMw < 0 && powerLocal > 0n) {
        total -= powerLocal;
        this.engine.bookLedgerEntry(sectorId, [
          "HV power ring deficit import (T -> World)",
          0n,
          0n,
          0n,
          -powerLocal,
          0n,
          0n,
          powerLocal,
        ]);
      }
    }

    // Gas: sold across the border via `[Fc <-> World]` + Contour B municipal clearing (sheet 19)
    const gas = this.gas?.sectors.find((g) => g.sectorId === sectorId);
    const gasPrice = getCustomsTables().gasRoutes.get("domestic")!.deliveredCostPerKm3Units;
    if (gas) {
      const netKm3 = gas.exportedKm3PerHour - gas.importedKm3PerHour;
      const gasLocal = mulRate(money(gasPrice * 720 * Math.abs(netKm3)), reg.fxRatePerWcu);
      if (netKm3 > 0 && gasLocal > 0n) {
        total += gasLocal;
        this.engine.bookLedgerEntry(sectorId, [
          "Trunk pipeline gas export (World -> Fc)",
          0n,
          gasLocal,
          0n,
          0n,
          0n,
          0n,
          -gasLocal,
        ]);
        this.engine.bookLedgerEntry(sectorId, [
          "Municipal Contour B gas revenue (Fc -> T)",
          0n,
          -gasLocal,
          0n,
          gasLocal,
          0n,
          0n,
          0n,
        ]);
      } else if (netKm3 < 0 && gasLocal > 0n) {
        total -= gasLocal;
        this.engine.bookLedgerEntry(sectorId, [
          "Trunk pipeline gas import (Fc -> World)",
          0n,
          -gasLocal,
          0n,
          0n,
          0n,
          0n,
          gasLocal,
        ]);
        this.engine.bookLedgerEntry(sectorId, [
          "Municipal gas clearing (T -> Fc)",
          0n,
          gasLocal,
          0n,
          -gasLocal,
          0n,
          0n,
          0n,
        ]);
      }

      // Emergency backup mazut (fuel oil) cost when ENG-02 turbines run without full pipeline gas
      if (gas.backupFuelOilBurned) {
        let shortfallTurbineLevels = 0;
        for (const b of this.buildings.values()) {
          if (b.sectorId !== sectorId || b.catalogId !== "ENG-02" || b.constructionProgress < 1 || b.stalledAwaitingPrivate) {
            continue;
          }
          const share = this.gas?.turbineSupply.get(b.id) ?? 0;
          if (share < 1) shortfallTurbineLevels += b.level * (1 - share);
        }
        const mazutLocal = mulRate(money(shortfallTurbineLevels * 6 * 95 * 720), reg.fxRatePerWcu);
        if (mazutLocal > 0n) {
          total -= mazutLocal;
          this.engine.bookLedgerEntry(sectorId, [
            "Emergency turbine fuel oil import (T -> World)",
            0n,
            0n,
            0n,
            -mazutLocal,
            0n,
            0n,
            mazutLocal,
          ]);
        }
      }
    }

    // Megaproject dividends (WCU) and dividends on stakes in neighbours' plants
    const megaDivLocal = mulRate(megaprojectDividends(this.megaprojectList()).get(sectorId) ?? 0n, reg.fxRatePerWcu);
    if (megaDivLocal > 0n) {
      total += megaDivLocal;
      this.engine.bookLedgerEntry(sectorId, [
        "Central Core megaproject dividend (World -> T)",
        0n,
        0n,
        0n,
        megaDivLocal,
        0n,
        0n,
        -megaDivLocal,
      ]);
    }
    const companies = new Map(this.listedCompanies().map((c) => [c.buildingId, c]));
    let foreignDivIn = 0n;
    let foreignDivOut = 0n;
    for (const stake of this.foreignStakes) {
      const c = companies.get(stake.buildingId);
      if (!c || stake.share <= 0) continue;
      const divHome = stakeMonthlyDividend(c, stake.share);
      if (stake.holderSector === sectorId) {
        const home = this.engine.getRegion(c.sectorId);
        foreignDivIn += mulRate(divHome, reg.fxRatePerWcu / home.fxRatePerWcu);
      }
      if (c.sectorId === sectorId) {
        foreignDivOut += divHome;
      }
    }
    if (foreignDivIn > 0n) {
      total += foreignDivIn;
      this.engine.bookLedgerEntry(sectorId, [
        "Cross-border equity dividend inflow (World -> T)",
        0n,
        0n,
        0n,
        foreignDivIn,
        0n,
        0n,
        -foreignDivIn,
      ]);
    }
    if (foreignDivOut > 0n) {
      this.engine.bookLedgerEntry(sectorId, [
        "Foreign shareholder dividend payout (Fc -> World)",
        0n,
        -foreignDivOut,
        0n,
        0n,
        0n,
        0n,
        foreignDivOut,
      ]);
    }
    return total;
  }

  /**
   * AI Governor (GDD §1.2): after 48 real hours without the mayor it runs the region conservatively —
   * Taylor rule, 6% duty, standard Road Service and repairs of crumbling roads within budget.
   */
  private runAiGovernors(): string[] {
    const alerts: string[] = [];
    for (const sectorId of this.engine.evaluateAiGovernorTimeouts(Date.now())) {
      alerts.push(`🤖 Сектор ${sectorId}: мэр не заходил 48 ч — управление принял ИИ-Губернатор`);
    }
    for (const sectorId of SECTOR_IDS) {
      const reg = this.engine.getRegion(sectorId);
      if (!reg.isAiGovernor || !this.occupiedBySector.get(sectorId)) continue;
      this.roadServiceLevel.set(sectorId, 1);
      const crumbling = [...this.segments.values()].some(
        (s) => s.sectorId === sectorId && isRoadKind(s.kind) && s.healthPercent < AI_GOVERNOR_REPAIR_BELOW
      );
      if (crumbling) {
        const out = this.handleRepairRoad(sectorId);
        if (out.ok) alerts.push(`🤖 ИИ-Губернатор Сектора ${sectorId}: ${out.message}`);
      }
    }
    return alerts;
  }

  /** Opens an emergency and dispatches the nearest responders over the road network. */
  private spawnEmergency(sp: EmergencySpawn): string {
    const spec = CANONICAL_EMERGENCIES.find((e) => e.id === sp.emergencyId)!;
    const responders = planDispatch({
      catalogs: this.catalogs,
      emergencyId: sp.emergencyId,
      sectorId: sp.sectorId,
      tileX: sp.tileX,
      tileY: sp.tileY,
      buildings: [...this.buildings.values()],
      segments: [...this.segments.values()],
    });
    const attended = responders.length > 0;
    const onSite = ON_SITE_HOURS[sp.emergencyId] ?? 2;
    const eta = attended ? Math.max(...responders.map((r) => r.etaHours)) : 0;
    const durationHours = attended ? eta + onSite : onSite * UNATTENDED_DURATION_MULTIPLIER;
    const emg: ActiveEmergencyDto = {
      instanceId: this.nextId("emg"),
      emergencyId: sp.emergencyId,
      sectorId: sp.sectorId,
      tileX: sp.tileX,
      tileY: sp.tileY,
      titleRu: `${spec.nameRu}: ${spec.impactSummaryRu}`,
      expiresAtGameSeconds: this.totalGameSeconds + Math.round(durationHours * 3600),
      causeRu: sp.causeRu,
      targetRef: sp.targetRef,
      attended,
      responders: responders.map((r) => ({
        buildingId: r.buildingId,
        vehicleTypeId: r.vehicleTypeId,
        arrivesAtGameSeconds: this.totalGameSeconds + Math.round(r.etaHours * 3600),
        path: r.path,
      })),
    };
    this.emergencies.push(emg);
    this.trafficDirty = true;
    const crew = attended
      ? `выехала бригада (${responders.map((r) => this.catalogs.vehiclesById.get(r.vehicleTypeId)?.nameRu ?? r.vehicleTypeId).join(", ")}), прибытие через ${Math.max(1, Math.round(eta * 60))} мин`
      : spec.responderBuildingId
        ? `нет службы ${spec.responderBuildingId} рядом — ЧП затянется`
        : "служба не требуется";
    return `🚨 Сектор ${sp.sectorId}: ${spec.nameRu} (${sp.causeRu}) — ${crew}`;
  }

  private applyEmergencyDamage(emg: ActiveEmergencyDto, gridlocked = false): string {
    const name = emg.titleRu.split(":")[0];
    const ref = emg.targetRef ?? "";
    const reg = this.engine.getRegion(emg.sectorId);
    reg.happinessIndex = Math.max(15, reg.happinessIndex - 3);
    const cleanup = money(45_000 * reg.cpi * reg.fxRatePerWcu);
    this.engine.bookLedgerEntry(emg.sectorId, [
      "Emergency damage & cleanup (T -> Fc)",
      0n,
      cleanup,
      0n,
      -cleanup,
      0n,
      0n,
      0n,
    ]);
    if (this.occupiedBySector.get(emg.sectorId) && reg.treasuryCashAtCb >= cleanup) {
      reg.treasuryCashAtCb -= cleanup;
      this.persistSectorState(emg.sectorId);
    }
    const reasonTag = gridlocked ? "бригада застряла в пробке (V/C > 1.2)" : "без помощи служб";
    if (emg.emergencyId === "FIRE") {
      const b = this.buildings.get(ref);
      if (b && b.level > 1) {
        const updated: BuildingDto = { ...b, level: b.level - 1 };
        this.buildings.set(b.id, updated);
        this.db.upsertBuilding(updated);
        return `🔥 Сектор ${emg.sectorId}: пожар (${reasonTag}) — «${this.catalogs.buildingsById.get(b.catalogId)?.nameRu ?? b.catalogId}» потерял уровень (Ур.${updated.level})`;
      }
      const z = this.zones.get(ref);
      if (z) {
        const updated: ZoneDto = { ...z, occupancyRatio: Math.max(0, Number((z.occupancyRatio - 0.25).toFixed(4))) };
        this.zones.set(z.id, updated);
        this.db.upsertZone(updated);
        return `🔥 Сектор ${emg.sectorId}: пожар (${reasonTag}) выжег четверть квартала ${z.zoneKind} #${z.id}`;
      }
    }
    if (emg.emergencyId === "ROAD_CRASH") {
      const seg = this.segments.get(ref);
      if (seg) {
        const updated: NetworkSegmentDto = { ...seg, healthPercent: Math.max(MIN_ROAD_HEALTH_PERCENT, seg.healthPercent - 15) };
        this.segments.set(seg.id, updated);
        this.db.upsertSegment(updated);
        return `🚧 Сектор ${emg.sectorId}: ДТП (${reasonTag}) — дорога ${seg.id} разбита ещё сильнее (${updated.healthPercent.toFixed(0)}%)`;
      }
    }
    return `⚠️ Сектор ${emg.sectorId}: ЧП «${name}» нанесло ущерб (${reasonTag}, счастье −3)`;
  }

  private emergencyStatusRu(emg: ActiveEmergencyDto): string | undefined {
    if (emg.attended === undefined) return undefined;
    if (!emg.attended) return "Службы нет рядом — ЧП длится втрое дольше и наносит ущерб";
    if (this.traffic?.congestedDispatches.has(emg.instanceId)) {
      return "Бригада застряла в пробке (V/C > 1.2) — расширьте улицу или почините асфальт!";
    }
    const arrival = Math.max(...(emg.responders ?? []).map((r) => r.arrivesAtGameSeconds));
    if (arrival > this.totalGameSeconds) {
      return `Бригада с сиреной в пути: ${Math.max(1, Math.round((arrival - this.totalGameSeconds) / 60))} игр. мин`;
    }
    return `Работы на месте: ещё ${Math.max(1, Math.round((emg.expiresAtGameSeconds - this.totalGameSeconds) / 60))} игр. мин`;
  }

  // ---------------------------------------------------------------------------------------------
  // Sprint 5: live traffic, public transport & agent inspector
  // ---------------------------------------------------------------------------------------------

  private recomputeTraffic(): TrafficComputation {
    const cal = computeDualCalendar(this.totalGameSeconds, this.catalogs.unitsAndTime.timeBase);
    this.trafficVersion += 1;
    this.gas = runGasNetwork({
      catalogs: this.catalogs,
      segments: [...this.segments.values()],
      buildings: [...this.buildings.values()],
      links: this.utilityLinks("pipeline"),
      sectorIds: SECTOR_IDS,
    });
    const roadLinks = this.roadLinks();
    this.traffic = computeTraffic({
      links: roadLinks,
      crossing: (postId, from, to, commodity) => crossingTerms(this.borderPosts.get(postId), from, to, commodity),
      plantOutputMultiplier: this.gas.outputMultiplier,
      catalogs: this.catalogs,
      segments: [...this.segments.values()],
      buildings: [...this.buildings.values()],
      zones: [...this.zones.values()],
      busRoutes: [...this.busRoutes.values()],
      gateways: this.map.gateways,
      sectors: SECTOR_IDS.map((sectorId) => {
        const reg = this.engine.getRegion(sectorId);
        return {
          sectorId,
          activeDecreeIds: [...reg.levers.activeDecreeIds],
          roadServiceLevel: this.roadServiceLevel.get(sectorId) ?? 1,
          fxRatePerWcu: reg.fxRatePerWcu,
        };
      }),
      gameHourOfDay: cal.economicHourOfDay,
      version: this.trafficVersion,
      dispatches: this.emergencies.flatMap((e) =>
        (e.responders ?? []).map((r) => ({
          emergencyInstanceId: e.instanceId,
          emergencyTitleRu: e.titleRu.split(":")[0]!,
          sectorId: e.sectorId,
          vehicleTypeId: r.vehicleTypeId,
          buildingId: r.buildingId,
          tileX: e.tileX,
          tileY: e.tileY,
        }))
      ),
    });
    this.city = computeCityServices({
      catalogs: this.catalogs,
      map: this.map,
      segments: [...this.segments.values()],
      zones: [...this.zones.values()],
      buildings: [...this.buildings.values()],
      emergencies: this.emergencies,
      metroZoneIds: this.traffic.metroZoneIds,
      busZoneIds: this.traffic.busZoneIds,
      pollutionMultiplier: this.gas.pollutionMultiplier,
      sectors: SECTOR_IDS.map((sectorId) => {
        const reg = this.engine.getRegion(sectorId);
        return { sectorId, activeDecreeIds: [...reg.levers.activeDecreeIds], hardshipShare: reg.hardshipShare };
      }),
    });
    this.crossBorderFlows = this.traffic.crossBorderFlows;
    const linked = new Set(roadLinks.map((l) => l.id));
    const residents = new Map(this.city.sectors.map((c) => [c.sectorId, c.residents]));
    this.borderStats = [...this.borderPosts.values()].map((post) =>
      borderPostStats({
        post,
        level: this.postLevel(post.id),
        roadLinked: linked.has(post.id),
        flows: this.crossBorderFlows,
        fxRatePerWcu: (s) => this.engine.getRegion(s).fxRatePerWcu,
        residents: (s) => residents.get(s) ?? 0,
      })
    );
    this.trafficDirty = false;
    return this.traffic;
  }

  private ensureTraffic(): TrafficComputation {
    return this.traffic && !this.trafficDirty ? this.traffic : this.recomputeTraffic();
  }

  public getTrafficState(): TrafficStateDto {
    return this.ensureTraffic().state;
  }

  private sectorRoadServiceCost(sectorId: SectorId): Money {
    const level = this.roadServiceLevel.get(sectorId) ?? 1;
    let wcu = 0n;
    for (const seg of this.segments.values()) {
      if (seg.sectorId !== sectorId || seg.id.startsWith("GW-STUB-") || !isRoadKind(seg.kind)) continue;
      wcu += roadServiceMonthlyCost(seg.kind, Math.hypot(seg.toX - seg.fromX, seg.toY - seg.fromY) * 10, level);
    }
    return mulRate(wcu, this.engine.getRegion(sectorId).fxRatePerWcu);
  }

  private dossierRegionInput(sectorId: SectorId) {
    const reg = this.engine.getRegion(sectorId);
    const power = this.effectivePower(sectorId);
    return {
      classes: reg.classes,
      cpi: reg.cpi,
      happinessIndex: reg.happinessIndex,
      annualInflation:
        reg.lastReport?.annualInflation ?? (reg.inflationHistory[reg.inflationHistory.length - 1] ?? 0.0025) * 12,
      keyRate: reg.levers.keyRate,
      vatRate: reg.levers.vatRate,
      exportDutyRate: reg.levers.exportDutyRate,
      fxRatePerWcu: reg.fxRatePerWcu,
      activeDecreeIds: [...reg.levers.activeDecreeIds],
      powerDeficit: power.supplyMw < power.demandMw,
      currencySymbol: currencySymbol(reg.currency),
    };
  }

  public inspectVehicle(vehicleId: string): VehicleInspectorDto | null {
    const rec = this.ensureTraffic().vehicles.get(vehicleId);
    if (!rec) return null;
    return buildVehicleInspector(rec, this.catalogs, this.dossierRegionInput(rec.dto.sectorId));
  }

  public getCitizenDossier(citizenId: string): CitizenDossierDto | null {
    const ctx = this.ensureTraffic().citizens.get(citizenId);
    if (!ctx) return null;
    const homeDistrict = ctx.homeZoneId ? this.ensureCity().districts.find((d) => d.zoneId === ctx.homeZoneId) : undefined;
    const autoStats = this.autoStats.find((a) => a.sectorId === ctx.sectorId);
    return buildCitizenDossier(ctx, { ...this.dossierRegionInput(ctx.sectorId), homeDistrict, autoStats });
  }

  public executeCommand(cmd: ClientCommand): CommandOutcome {
    const outcome = this.dispatchCommand(cmd);
    if (outcome.ok && TRAFFIC_AFFECTING_COMMANDS.has(cmd.type)) {
      this.trafficDirty = true;
    }
    return outcome;
  }

  /** Traffic version the latest snapshot refers to (clients refetch `/api/traffic` when it changes). */
  public getTrafficVersion(): number {
    this.ensureTraffic();
    return this.trafficVersion;
  }

  private dispatchCommand(cmd: ClientCommand): CommandOutcome {
    switch (cmd.type) {
      case "claim_sector":
        return this.handleClaimSector(cmd);
      case "reset_sector":
        return this.handleResetSector(cmd.sectorId);
      case "build_segment":
        return this.handleBuildSegment(cmd);
      case "paint_zone":
        return this.handlePaintZone(cmd);
      case "upgrade_zone":
        return this.handleUpgradeZone(cmd.sectorId, cmd.zoneId, cmd.targetZoneKind);
      case "demolish_zone":
        return this.handleDemolishZone(cmd.sectorId, cmd.zoneId);
      case "place_building":
        return this.handlePlaceBuilding(cmd);
      case "buyout_factory":
        return this.handleBuyoutFactory(cmd.sectorId, cmd.buildingId);
      case "upgrade_building":
        return this.handleUpgradeBuilding(cmd.sectorId, cmd.buildingId, cmd.mayorPaysAll);
      case "bulldoze_building":
        return this.handleBulldozeBuilding(cmd.sectorId, cmd.buildingId);
      case "demolish_building":
        return this.handleDemolishBuilding(cmd.sectorId, cmd.buildingId);
      case "update_policy":
        return this.handleUpdatePolicy(cmd);
      case "send_chat":
        return this.handleSendChat(cmd);
      case "admin_time_skip":
        return this.handleAdminTimeSkip(cmd.jump);
      case "admin_trigger_emergency":
        return this.handleAdminEmergency(cmd.sectorId, cmd.emergencyId);
      case "create_bus_route":
        return this.handleCreateBusRoute(cmd);
      case "delete_bus_route":
        return this.handleDeleteBusRoute(cmd.sectorId, cmd.routeId);
      case "repair_road":
        return this.handleRepairRoad(cmd.sectorId, cmd.segmentId);
      case "set_border_policy":
        return this.handleSetBorderPolicy(cmd);
      case "set_gas_valve":
        return this.handleSetGasValve(cmd);
      case "found_megaproject":
        return this.handleFoundMegaproject(cmd);
      case "contribute_megaproject":
        return this.handleContributeMegaproject(cmd);
      case "trade_stake":
        return this.handleTradeStake(cmd);
      case "preempt_takeover":
        return this.handlePreemptTakeover(cmd);
      case "claim_quest_reward":
        return this.handleClaimQuestReward(cmd);
    }
  }

  private handleCreateBusRoute(
    cmd: Extract<ClientCommand, { type: "create_bus_route" }>
  ): CommandOutcome {
    const reg = this.engine.getRegion(cmd.sectorId);
    reg.lastMayorActivityEpochMs = Date.now();
    const stopIds = cmd.stopBuildingIds.filter((id, i, all) => all.indexOf(id) === i);
    if (stopIds.length < 2 || stopIds.length > 16) {
      return { ok: false, message: "Маршрут должен включать от 2 до 16 разных остановок" };
    }
    for (const id of stopIds) {
      const b = this.buildings.get(id);
      if (!b || b.catalogId !== "TRN-01" || b.sectorId !== cmd.sectorId) {
        return { ok: false, message: `Объект ${id} не является автобусной остановкой вашего сектора` };
      }
    }
    const hasDepot = [...this.buildings.values()].some(
      (b) => b.catalogId === "TRN-02" && b.sectorId === cmd.sectorId
    );
    if (!hasDepot) {
      return { ok: false, message: "Сначала постройте Автобусный парк (TRN-02): он выдаёт лицензии перевозчикам" };
    }

    const fleetSize = Math.max(1, Math.min(20, Math.round(cmd.fleetSize ?? 4)));
    const routeNumber = [...this.busRoutes.values()].filter((r) => r.sectorId === cmd.sectorId).length + 1;
    const id = this.nextId("route");
    const operator = BUS_OPERATORS[(cmd.sectorId * 7 + routeNumber) % BUS_OPERATORS.length]!;
    const fee = money(BUS_LICENSE_FEE_PER_BUS_PER_MONTH_UNITS * fleetSize * reg.fxRatePerWcu);
    const route: BusRouteDto = {
      id,
      sectorId: cmd.sectorId,
      name: (cmd.name ?? "").trim().slice(0, 40) || `№${routeNumber}`,
      operatorName: `ТОВ «${operator}»`,
      stopBuildingIds: stopIds,
      fleetSize,
      vehicleTypeId: "PT-02",
      licenseFeeMonthlyMinor: fee.toString(),
    };
    this.busRoutes.set(id, route);
    this.db.upsertBusRoute(route);

    const status = this.recomputeTraffic().state.busRoutes.find((r) => r.routeId === id);
    const sym = currencySymbol(reg.currency);
    return {
      ok: true,
      message: `Лицензия на маршрут ${route.name} выдана ${route.operatorName} (${fleetSize} авт., сбор ${fmtSym(fee, sym)}/мес). ${status?.statusRu ?? ""}`,
    };
  }

  private handleDeleteBusRoute(sectorId: SectorId, routeId: string): CommandOutcome {
    const route = this.busRoutes.get(routeId);
    if (!route || route.sectorId !== sectorId) {
      return { ok: false, message: "Маршрут не найден в вашем секторе" };
    }
    this.busRoutes.delete(routeId);
    this.db.deleteBusRoute(routeId);
    return { ok: true, message: `Лицензия маршрута ${route.name} (${route.operatorName}) отозвана` };
  }

  private handleRepairRoad(sectorId: SectorId, segmentId?: string): CommandOutcome {
    const reg = this.engine.getRegion(sectorId);
    reg.lastMayorActivityEpochMs = Date.now();
    const targets = [...this.segments.values()].filter(
      (s) =>
        s.sectorId === sectorId &&
        isRoadKind(s.kind) &&
        s.healthPercent < 100 &&
        (segmentId ? s.id === segmentId : s.healthPercent < 75)
    );
    if (targets.length === 0) {
      return {
        ok: false,
        message: segmentId ? "Дорога не найдена или уже в идеальном состоянии" : "В секторе нет изношенных дорог (<75%)",
      };
    }
    let cost = 0n;
    for (const s of targets) {
      if (!isRoadKind(s.kind)) continue;
      const lengthMeters = Math.hypot(s.toX - s.fromX, s.toY - s.fromY) * 10 * (s.hasBridge ? 3 : 1);
      cost += roadRepairCost(s.kind, lengthMeters, s.healthPercent, reg.fxRatePerWcu);
    }
    const sym = currencySymbol(reg.currency);
    if (reg.treasuryCashAtCb < cost) {
      return {
        ok: false,
        message: `Недостаточно средств на ремонт: нужно ${fmtSym(cost, sym)}, доступно ${fmtSym(reg.treasuryCashAtCb, sym)}`,
      };
    }
    reg.treasuryCashAtCb -= cost;
    this.persistSectorState(sectorId);
    for (const s of targets) {
      const updated: NetworkSegmentDto = { ...s, healthPercent: 100 };
      this.segments.set(s.id, updated);
      this.db.upsertSegment(updated);
    }
    return {
      ok: true,
      message: `Дорожная служба перестелила ${targets.length} уч. дорог за ${fmtSym(cost, sym)} — прочность 100%`,
    };
  }

  private handleClaimSector(
    cmd: Extract<ClientCommand, { type: "claim_sector" }>
  ): CommandOutcome {
    const { sectorId, currency } = cmd;
    const cityName = cmd.cityName.trim() || `Пентаград-${sectorId}`;
    const mayorName = cmd.mayorName.trim() || `Мэр Сектора ${sectorId}`;

    let spec;
    try {
      spec = getCurrencySpec(currency);
    } catch {
      return { ok: false, message: `Недопустимая национальная валюта: ${currency}` };
    }
    if (currency === ("WCU" as CurrencyCode)) {
      return { ok: false, message: `Недопустимая национальная валюта: ${currency}` };
    }

    // 1. Check uniqueness among OTHER occupied sectors
    const otherOccupiedCurrencies = new Set<CurrencyCode>();
    let otherOccupiedCount = 0;
    for (const s of SECTOR_IDS) {
      if (s === sectorId) continue;
      if (this.occupiedBySector.get(s)) {
        otherOccupiedCount += 1;
        otherOccupiedCurrencies.add(this.engine.getRegion(s).currency);
      }
    }
    if (otherOccupiedCurrencies.has(currency)) {
      return {
        ok: false,
        message: `Валюта ${spec.symbol} (${currency}) уже выбрана другим мэром в этом мире!`,
      };
    }

    // 2. Enforce mandatory Hryvnia (₴ UAH) on the 5th slot if none of the other 4 chose UAH (GDD §3.2)
    if (
      otherOccupiedCount === 4 &&
      !otherOccupiedCurrencies.has("UAH") &&
      currency !== "UAH"
    ) {
      return {
        ok: false,
        message:
          "В каждом мире из 5 регионов обязательно должна присутствовать Гривна (₴ UAH) — выберите UAH для 5-го слота!",
      };
    }

    const reg = this.engine.getRegion(sectorId);
    const prevCurrency = reg.currency;

    // Keep all 5 sectors holding distinct currencies (with UAH always present across the 5 slots)
    if (prevCurrency !== currency) {
      for (const s of SECTOR_IDS) {
        if (s !== sectorId && !this.occupiedBySector.get(s)) {
          const otherReg = this.engine.getRegion(s);
          if (otherReg.currency === currency) {
            otherReg.currency = prevCurrency;
            this.persistSectorState(s);
            break;
          }
        }
      }
      reg.currency = currency;

      // Guarantee UAH remains in at least one unoccupied slot if no occupied sector holds UAH yet
      const allFiveHasUah = SECTOR_IDS.some((s) => this.engine.getRegion(s).currency === "UAH");
      if (!allFiveHasUah) {
        const freeSlot = SECTOR_IDS.find((s) => s !== sectorId && !this.occupiedBySector.get(s));
        if (freeSlot) {
          this.engine.getRegion(freeSlot).currency = "UAH";
          this.persistSectorState(freeSlot);
        }
      }
      // Guarantee no duplicate currency on unoccupied slots
      const usedSet = new Set<CurrencyCode>([currency, ...otherOccupiedCurrencies]);
      for (const s of SECTOR_IDS) {
        if (s === sectorId || this.occupiedBySector.get(s)) continue;
        const r = this.engine.getRegion(s);
        if (usedSet.has(r.currency)) {
          const replacement = NATIONAL_CURRENCIES.find(
            (c) => !usedSet.has(c.code as CurrencyCode)
          );
          if (replacement) {
            r.currency = replacement.code as CurrencyCode;
            this.persistSectorState(s);
          }
        }
        usedSet.add(r.currency);
      }
    }

    const wasOccupied = this.occupiedBySector.get(sectorId) ?? false;
    this.occupiedBySector.set(sectorId, true);
    reg.cityName = cityName;
    reg.mayorDisplayName = mayorName;
    reg.mayorUid = `mayor-s${sectorId}`;
    reg.isAiGovernor = false;
    reg.lastMayorActivityEpochMs = Date.now();

    // Late-joiner greenfield treasury bonus: $10M + $1M per elapsed season day up to Day 15 (GDD §1.5)
    if (!wasOccupied) {
      const seasonDay = Math.min(30, Math.floor(this.totalGameSeconds / 86_400) + 1);
      const lateBonusUnits = Math.min(14, Math.max(0, seasonDay - 1)) * 1_000_000;
      const startUnits = (10_000_000 + lateBonusUnits) * reg.fxRatePerWcu;
      reg.treasuryCashAtCb = money(startUnits);
    }

    this.persistSectorState(sectorId);
    this.pushSystemChat(
      `Мэр ${mayorName} возглавил Сектор ${sectorId} («${cityName}»), национальная валюта: ${spec.nameRu} (${spec.symbol} ${currency}).`
    );

    return {
      ok: true,
      message: `Сектор ${sectorId} («${cityName}») закреплён за вами. Казна: ${fmtSym(reg.treasuryCashAtCb, spec.symbol)}`,
    };
  }

  private handleResetSector(sectorId: SectorId): CommandOutcome {
    const reg = this.engine.getRegion(sectorId);
    const profile = this.catalogs.sectors.find((s) => s.sectorId === sectorId);

    for (const [id, seg] of this.segments) {
      if (seg.sectorId === sectorId && !id.startsWith("GW-STUB-")) {
        this.segments.delete(id);
      }
    }
    for (const [id, z] of this.zones) {
      if (z.sectorId === sectorId) this.zones.delete(id);
    }
    for (const [id, b] of this.buildings) {
      if (b.sectorId === sectorId) this.buildings.delete(id);
    }
    for (const [id, route] of this.busRoutes) {
      if (route.sectorId === sectorId) this.busRoutes.delete(id);
    }
    this.roadServiceLevel.set(sectorId, 1);
    this.db.setMeta(`roadService:S${sectorId}`, "1");
    this.claimedQuests.set(sectorId, new Set());
    this.db.setMeta(`quests:S${sectorId}`, "[]");
    for (let i = this.emergencies.length - 1; i >= 0; i--) {
      if (this.emergencies[i]!.sectorId === sectorId) this.emergencies.splice(i, 1);
    }
    this.fleets.get(sectorId)!.fleet = [0, 0, 0, 0, 0];
    // Posts built by this sector go with it; on the neighbour's posts its side returns to defaults
    for (const post of [...this.borderPosts.values()]) {
      if (this.buildings.get(post.id)?.sectorId === sectorId) {
        this.borderPosts.delete(post.id);
        this.db.deleteBorderPost(post.id);
      } else if (post.sides.some((sd) => sd.sectorId === sectorId)) {
        const reset: BorderPostDto = {
          ...post,
          sides: post.sides.map((sd) => (sd.sectorId === sectorId ? newBorderPost(this.buildings.get(post.id)!, sectorId, sectorId).sides[0]! : sd)),
          pending: post.pending.filter((c) => c.sectorId !== sectorId),
        };
        this.borderPosts.set(post.id, reset);
        this.db.upsertBorderPost(reset);
      }
    }
    for (let i = this.foreignStakes.length - 1; i >= 0; i--) {
      if (this.foreignStakes[i]!.holderSector === sectorId) {
        this.db.upsertEquityStake(this.foreignStakes[i]!.buildingId, sectorId, 0);
        this.foreignStakes.splice(i, 1);
      }
    }
    for (let i = this.pendingTakeovers.length - 1; i >= 0; i--) {
      const tk = this.pendingTakeovers[i]!;
      if (tk.bidderSectorId === sectorId || tk.targetSectorId === sectorId) {
        this.pendingTakeovers.splice(i, 1);
      }
    }
    this.persistTakeovers();
    this.db.setMeta(`fleet:S${sectorId}`, "[0,0,0,0,0]");
    reg.factories.length = 0;
    reg.pendingCustomRows.length = 0;
    this.lastConstruction = null;
    this.db.deleteSectorEntities(sectorId);

    this.occupiedBySector.set(sectorId, false);
    reg.cityName = profile ? `${profile.nameRu} (S${sectorId})` : `Сектор ${sectorId}`;
    reg.mayorDisplayName = "ИИ-Управляющий (Свободно)";
    reg.mayorUid = null;
    reg.isAiGovernor = false;
    reg.treasuryCashAtCb = money(10_000_000 * reg.fxRatePerWcu);
    reg.levers.importDutyRate = 0.06;
    reg.levers.vatRate = 0.10;
    reg.levers.corpTaxRate = 0.18;
    reg.levers.keyRate = 0.07;
    reg.levers.activeDecreeIds = [];
    this.persistSectorState(sectorId);

    this.pushSystemChat(`Сектор ${sectorId} очищен до чистого листа и открыт для нового мэра.`);
    return { ok: true, message: `Сектор ${sectorId} сброшен до стартового состояния ($10M).` };
  }

  private handleBuildSegment(
    cmd: Extract<ClientCommand, { type: "build_segment" }>
  ): CommandOutcome {
    const reg = this.engine.getRegion(cmd.sectorId);
    reg.lastMayorActivityEpochMs = Date.now();
    reg.isAiGovernor = false;

    const quote = validateAndQuoteNetworkSegment({
      map: this.map,
      sectorId: cmd.sectorId,
      kind: cmd.kind,
      fromX: cmd.fromX,
      fromY: cmd.fromY,
      toX: cmd.toX,
      toY: cmd.toY,
      isFlyover: cmd.isFlyover,
      fxRatePerWcu: reg.fxRatePerWcu,
    });
    if (!quote.ok) {
      return { ok: false, message: quote.reason };
    }

    const cost = quote.preview.buildCostLocal;
    if (reg.treasuryCashAtCb < cost) {
      const sym = currencySymbol(reg.currency);
      return {
        ok: false,
        message: `Недостаточно средств казны: нужно ${fmtSym(cost, sym)}, доступно ${fmtSym(reg.treasuryCashAtCb, sym)}`,
      };
    }

    reg.treasuryCashAtCb -= cost;
    this.persistSectorState(cmd.sectorId);

    const seg: NetworkSegmentDto = {
      id: this.nextId("seg"),
      sectorId: cmd.sectorId,
      kind: cmd.kind,
      fromX: cmd.fromX,
      fromY: cmd.fromY,
      toX: cmd.toX,
      toY: cmd.toY,
      hasBridge: quote.preview.hasBridge,
      isFlyover: quote.preview.isFlyover,
      healthPercent: 100,
    };
    this.segments.set(seg.id, seg);
    this.db.upsertSegment(seg);

    const sym = currencySymbol(reg.currency);
    const bridgeTag = seg.hasBridge ? " (вкл. мост 3x через реку)" : seg.isFlyover ? " (эстакада Z=+1)" : "";
    return {
      ok: true,
      message: `Построена сеть ${cmd.kind} (${Math.round(quote.preview.lengthMeters)} м)${bridgeTag} за ${fmtSym(cost, sym)}`,
    };
  }

  private handlePaintZone(
    cmd: Extract<ClientCommand, { type: "paint_zone" }>
  ): CommandOutcome {
    const reg = this.engine.getRegion(cmd.sectorId);
    reg.lastMayorActivityEpochMs = Date.now();
    const w = Math.max(2, Math.min(24, Math.round(cmd.width)));
    const d = Math.max(2, Math.min(24, Math.round(cmd.depth)));

    for (let dy = 0; dy < d; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const tx = cmd.x + dx;
        const ty = cmd.y + dy;
        if (tx < 0 || tx >= this.map.width || ty < 0 || ty >= this.map.height) {
          return { ok: false, message: "Зона выходит за пределы полуострова" };
        }
        const idx = ty * this.map.width + tx;
        if (this.map.owner[idx] !== (cmd.sectorId as OwnerCode)) {
          return { ok: false, message: `Зонировать можно только сушу своего Сектора ${cmd.sectorId}` };
        }
        if (this.map.surface[idx] !== SurfaceType.Land) {
          return { ok: false, message: "Нельзя размечать жилые/коммерческие зоны по воде" };
        }
      }
    }

    const surveyCost = mulRate(money(w * d * 250), reg.fxRatePerWcu);
    if (reg.treasuryCashAtCb < surveyCost) {
      return { ok: false, message: "Недостаточно средств в казне на межевание участка" };
    }
    reg.treasuryCashAtCb -= surveyCost;
    this.persistSectorState(cmd.sectorId);

    const zone: ZoneDto = {
      id: this.nextId("zone"),
      sectorId: cmd.sectorId,
      zoneKind: cmd.zoneKind,
      x: cmd.x,
      y: cmd.y,
      width: w,
      depth: d,
      occupancyRatio: 0,
    };
    this.zones.set(zone.id, zone);
    this.db.upsertZone(zone);
    this.lastConstruction = null;

    // Dwellings appear only as developers actually build them (applyDeveloperMarket)
    const bill = zoneMaterialBill(cmd.zoneKind, w * d);
    return {
      ok: true,
      message: `Размечена зона ${cmd.zoneKind} (${w}×${d} тайлов). Застройщикам понадобится ~${Math.round(bill.tons).toLocaleString("ru-RU")} т стройматериалов.`,
    };
  }

  private handlePlaceBuilding(
    cmd: Extract<ClientCommand, { type: "place_building" }>
  ): CommandOutcome {
    if (cmd.catalogId === "MEG-04") {
      return this.handleFoundMegaproject({ type: "found_megaproject", sectorId: cmd.sectorId, catalogId: "MEG-04" });
    }
    const entry = this.catalogs.buildingsById.get(cmd.catalogId);
    if (!entry) {
      return { ok: false, message: `Здание ${cmd.catalogId} не найдено в каталоге` };
    }

    const reg = this.engine.getRegion(cmd.sectorId);
    reg.lastMayorActivityEpochMs = Date.now();
    reg.isAiGovernor = false;

    const w = Math.max(2, entry.footprint.width || 4);
    const d = Math.max(2, entry.footprint.depth || 4);
    const isMegaproject = entry.prefix === "MEG";
    // Border posts straddle the border with one neighbour (GDD §5.3)
    let borderNeighbor: SectorId | null = null;
    if (entry.id === "LOG-07") {
      const sides = borderPostSides(this.map, cmd.sectorId, cmd.tileX, cmd.tileY, w, d);
      if (!sides.ok) return { ok: false, message: sides.reason };
      borderNeighbor = sides.neighbor;
    }
    if (isMegaproject) {
      if ([...this.buildings.values()].some((b) => b.catalogId === entry.id)) {
        return { ok: false, message: `«${entry.nameRu}» уже заложен в Ядре — внесите долю в него` };
      }
      const metropolises = SECTOR_IDS.filter(
        (s) => this.computeSectorStage(Math.round(this.engine.getRegion(s).classes.reduce((t, c) => t + c.households, 0))) === "S5"
      ).length;
      if (metropolises < 3) {
        return { ok: false, message: `Мегапроекты открываются, когда 3 из 5 регионов достигнут этапа S5 (сейчас ${metropolises})` };
      }
    }
    const allowsCoastOrSea =
      entry.id === "EXT-05" ||
      entry.id === "INF-07" ||
      entry.id === "LOG-04" ||
      entry.id === "LOG-05" ||
      entry.id === "PRO-08" ||
      entry.placement.toLowerCase().includes("coast") ||
      entry.placement.toLowerCase().includes("sea") ||
      entry.placement.toLowerCase().includes("river");

    for (let dy = 0; dy < d; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const tx = cmd.tileX + dx;
        const ty = cmd.tileY + dy;
        if (tx < 0 || tx >= this.map.width || ty < 0 || ty >= this.map.height) {
          return { ok: false, message: "Площадка здания выходит за границы карты" };
        }
        const idx = ty * this.map.width + tx;
        const ow = this.map.owner[idx]!;
        const surf = this.map.surface[idx]!;

        if (isMegaproject) {
          if (ow !== OwnerCode.CentralCore) {
            return {
              ok: false,
              message: "Мегапроекты строятся только в нейтральном Центральном Ядре (500, 500)",
            };
          }
        } else if (ow !== (cmd.sectorId as OwnerCode) && !allowsCoastOrSea && ow !== (borderNeighbor as number | null)) {
          return {
            ok: false,
            message: `Площадка (${tx}, ${ty}) находится вне границ Сектора ${cmd.sectorId}`,
          };
        }

        if (surf !== SurfaceType.Land && !allowsCoastOrSea) {
          return { ok: false, message: `Здание ${entry.nameRu} требует твёрдую сушу` };
        }
      }
    }

    // Check overlap with existing placed buildings
    for (const existing of this.buildings.values()) {
      const overlapX =
        cmd.tileX < existing.tileX + existing.width && cmd.tileX + w > existing.tileX;
      const overlapY =
        cmd.tileY < existing.tileY + existing.depth && cmd.tileY + d > existing.tileY;
      if (overlapX && overlapY) {
        return { ok: false, message: "Площадка пересекается с уже построенным объектом" };
      }
    }

    // Transit boarding points must sit on their network (GDD §5.4)
    if (entry.id === "TRN-01" || entry.id === "TRN-09") {
      const layer = entry.id === "TRN-09" ? "metro" : "road";
      const graph = buildNetworkGraph([...this.segments.values()], layer);
      const onNetwork = locateRectOnGraph(graph, { x: cmd.tileX, y: cmd.tileY, width: w, depth: d }, 3);
      if (!onNetwork) {
        return {
          ok: false,
          message:
            entry.id === "TRN-09"
              ? "Станция метро ставится только над тоннелем метро (слой «Под землёй»)"
              : `«${entry.nameRu}» нужно ставить вплотную к улице`,
        };
      }
    }

    const fullBuildCostLocal = mulRate(entry.buildCostLv1, reg.fxRatePerWcu);
    const sym = currencySymbol(reg.currency);
    const buildingId = this.nextId("bld");

    if (entry.ownershipContour === "co_invested_10_90") {
      const cityShare = Math.min(
        1.0,
        Math.max(0.10, cmd.cityShareOverride ?? reg.levers.cityNewPlantShare)
      );
      const cityOutlay = mulRate(fullBuildCostLocal, cityShare);
      if (reg.treasuryCashAtCb < cityOutlay) {
        return {
          ok: false,
          message: `Недостаточно средств казны на долю города (${Math.round(cityShare * 100)}%): нужно ${fmtSym(cityOutlay, sym)}`,
        };
      }

      reg.treasuryCashAtCb -= cityOutlay;
      const expectedAnnualRoi = Math.max(0.04, 0.18 * (1 - reg.levers.corpTaxRate));
      const project = this.engine.createFactoryProject({
        projectId: buildingId,
        sectorId: cmd.sectorId,
        buildingCatalogId: entry.id,
        buildCostLocal: fullBuildCostLocal,
        expectedAnnualRoi,
        cityShareOverride: cityShare,
      });
      this.persistSectorState(cmd.sectorId);

      const stalled = project.status === "awaiting_private_investors";
      const bld: BuildingDto = {
        id: buildingId,
        catalogId: entry.id,
        sectorId: cmd.sectorId,
        tileX: cmd.tileX,
        tileY: cmd.tileY,
        width: w,
        depth: d,
        orientationDeg: cmd.orientationDeg ?? 0,
        level: 1,
        constructionProgress: stalled ? 0.15 : entry.buildTimeGameHours <= 0 ? 1 : 0.4,
        cityEquityShare: stalled ? cityShare : project.cityShare,
        stalledAwaitingPrivate: stalled,
      };
      this.buildings.set(bld.id, bld);
      this.db.upsertBuilding(bld);

      if (stalled) {
        this.emergencies.push({
          instanceId: this.nextId("emg"),
          emergencyId: "FROZEN_CONSTRUCTION",
          sectorId: cmd.sectorId,
          tileX: cmd.tileX,
          tileY: cmd.tileY,
          titleRu: `Долгострой «${entry.nameRu}»: частный рынок ждёт снижения ставки ЦБ или выкупа 90% Мэрией`,
          expiresAtGameSeconds: this.totalGameSeconds + 86_400 * 5,
        });
        return {
          ok: true,
          message: `Заложен завод «${entry.nameRu}» (взнос Мэрии ${fmtSym(cityOutlay, sym)}). Частные инвесторы отказались от 90% из-за высокой ставки кредита — доступен 100% выкуп Мэрией!`,
        };
      }

      return {
        ok: true,
        message: `Завод «${entry.nameRu}» профинансирован! Мэрия: ${Math.round(project.cityShare * 100)}% (${fmtSym(cityOutlay, sym)}), частные инвесторы: ${Math.round(project.privateShare * 100)}%.`,
      };
    }

    // 100% Municipal / Contour B; megaprojects are founded for free and funded by contributions
    const outlay = isMegaproject ? 0n : fullBuildCostLocal;
    if (reg.treasuryCashAtCb < outlay) {
      return {
        ok: false,
        message: `Недостаточно средств казны: нужно ${fmtSym(outlay, sym)}, доступно ${fmtSym(reg.treasuryCashAtCb, sym)}`,
      };
    }
    reg.treasuryCashAtCb -= outlay;
    this.persistSectorState(cmd.sectorId);

    const bld: BuildingDto = {
      id: buildingId,
      catalogId: entry.id,
      sectorId: isMegaproject ? "core" : cmd.sectorId,
      tileX: cmd.tileX,
      tileY: cmd.tileY,
      width: w,
      depth: d,
      orientationDeg: cmd.orientationDeg ?? 0,
      level: 1,
      constructionProgress: isMegaproject ? 0 : entry.buildTimeGameHours <= 1 ? 1 : 0.5,
      cityEquityShare: isMegaproject ? 0 : 1.0,
      stalledAwaitingPrivate: isMegaproject,
    };
    this.buildings.set(bld.id, bld);
    this.db.upsertBuilding(bld);

    if (borderNeighbor !== null) {
      const post = newBorderPost(bld, cmd.sectorId, borderNeighbor);
      this.borderPosts.set(post.id, post);
      this.db.upsertBorderPost(post);
      this.pushSystemChat(`🛂 Сектор ${cmd.sectorId} построил КПП #${post.id} на границе с Сектором ${borderNeighbor}. Подведите к нему дороги с обеих сторон.`);
      return { ok: true, message: `Построен КПП #${post.id} на границе с Сектором ${borderNeighbor} за ${fmtSym(outlay, sym)}` };
    }
    if (isMegaproject) {
      this.pushSystemChat(`🌐 Сектор ${cmd.sectorId} заложил мегапроект «${entry.nameRu}» в Центральном Ядре — открыт сбор долей.`);
      return {
        ok: true,
        message: `Заложен мегапроект «${entry.nameRu}»: стоимость ${formatMoney(entry.buildCostLv1)} МРЕ, стройка начнётся после сбора взносов`,
      };
    }

    return {
      ok: true,
      message: `Построен объект «${entry.nameRu}» (${entry.id}) за ${fmtSym(outlay, sym)}`,
    };
  }

  private handleBuyoutFactory(sectorId: SectorId, buildingId: string): CommandOutcome {
    const bld = this.buildings.get(buildingId);
    if (!bld || bld.sectorId !== sectorId) {
      return { ok: false, message: "Здание не найдено в вашем секторе" };
    }
    const entry = this.catalogs.buildingsById.get(bld.catalogId);
    if (!entry) return { ok: false, message: "Неизвестный тип здания" };

    const reg = this.engine.getRegion(sectorId);
    const fullCost = mulRate(entry.buildCostLv1, reg.fxRatePerWcu);
    const remainingShare = Math.max(0, 1 - bld.cityEquityShare);
    const buyoutCost = mulRate(fullCost, remainingShare);
    const sym = currencySymbol(reg.currency);

    if (reg.treasuryCashAtCb < buyoutCost) {
      return {
        ok: false,
        message: `Недостаточно средств для выкупа ${Math.round(remainingShare * 100)}% пакета: нужно ${fmtSym(buyoutCost, sym)}`,
      };
    }

    reg.treasuryCashAtCb -= buyoutCost;
    const existingProj = reg.factories.find((f) => f.projectId === buildingId);
    if (existingProj) {
      this.engine.mayorBuyoutStalledFactory(sectorId, buildingId, fullCost);
    }
    this.persistSectorState(sectorId);

    const updated: BuildingDto = {
      ...bld,
      cityEquityShare: 1.0,
      stalledAwaitingPrivate: false,
      constructionProgress: 1.0,
    };
    this.buildings.set(buildingId, updated);
    this.db.upsertBuilding(updated);

    return {
      ok: true,
      message: `Мэрия выкупила 100% акций «${entry.nameRu}» за ${fmtSym(buyoutCost, sym)} — завод запущен!`,
    };
  }

  private handleUpgradeBuilding(
    sectorId: SectorId,
    buildingId: string,
    mayorPaysAll?: boolean
  ): CommandOutcome {
    const bld = this.buildings.get(buildingId);
    if (!bld || bld.sectorId !== sectorId) {
      return { ok: false, message: "Здание не найдено в вашем секторе" };
    }
    const entry = this.catalogs.buildingsById.get(bld.catalogId);
    if (!entry) return { ok: false, message: "Неизвестный тип здания" };
    if (bld.level >= entry.maxLevel) {
      return { ok: false, message: `Здание «${entry.nameRu}» уже на максимальном Ур.${entry.maxLevel}` };
    }
    if (bld.upgradeTargetLevel) {
      return {
        ok: false,
        message: `«${entry.nameRu}» уже модернизируется до Ур.${bld.upgradeTargetLevel} (${Math.round((bld.upgradeProgress ?? 0) * 100)}%)`,
      };
    }
    if (bld.constructionProgress < 1) {
      return { ok: false, message: `«${entry.nameRu}» ещё строится — модернизация после ввода в строй` };
    }

    const nextLevel = bld.level + 1;
    const stats = computeBuildingAtLevel(entry, this.catalogs.levelCurves, nextLevel);
    const reg = this.engine.getRegion(sectorId);
    const upgradeCostLocal = mulRate(stats.incrementalUpgradeCost, reg.fxRatePerWcu);
    const sym = currencySymbol(reg.currency);

    let cityPay = upgradeCostLocal;
    let newCityShare = bld.cityEquityShare;

    const proj = reg.factories.find((f) => f.projectId === buildingId);
    if (proj && entry.ownershipContour === "co_invested_10_90") {
      const loanRate = Math.max(0.01, reg.levers.keyRate + 0.03 - reg.levers.creditSubsidyRate);
      const privateWilling = !mayorPaysAll && proj.privateShare > 0 && proj.expectedAnnualRoi > loanRate;
      cityPay = privateWilling ? mulRate(upgradeCostLocal, proj.cityShare) : upgradeCostLocal;
      if (reg.treasuryCashAtCb < cityPay) {
        return {
          ok: false,
          message: `Недостаточно средств казны на модернизацию до Ур.${nextLevel}: нужно ${fmtSym(cityPay, sym)}`,
        };
      }
      reg.treasuryCashAtCb -= cityPay;
      const upgradedProj = this.engine.upgradeFactoryProject({
        sectorId,
        projectId: buildingId,
        upgradeCostLocal,
        mayorPaysAll,
      });
      newCityShare = upgradedProj.cityShare;
    } else {
      if (reg.treasuryCashAtCb < cityPay) {
        return {
          ok: false,
          message: `Недостаточно средств казны на Ур.${nextLevel}: нужно ${fmtSym(cityPay, sym)}`,
        };
      }
      reg.treasuryCashAtCb -= cityPay;
    }

    this.persistSectorState(sectorId);
    // Sheet 22 / level curve: each level takes game hours to build; the plant runs at its old level meanwhile
    const timed = stats.upgradeTimeGameHours > 0;
    const updated: BuildingDto = {
      ...bld,
      level: timed ? bld.level : nextLevel,
      cityEquityShare: Number(newCityShare.toFixed(4)),
      upgradeTargetLevel: timed ? nextLevel : null,
      upgradeProgress: timed ? 0 : 1,
    };
    this.buildings.set(buildingId, updated);
    this.db.upsertBuilding(updated);

    const share = `доля Мэрии: ${Math.round(updated.cityEquityShare * 100)}%, расход: ${fmtSym(cityPay, sym)}`;
    return {
      ok: true,
      message: timed
        ? `Начата модернизация «${entry.nameRu}» до Ур.${nextLevel}: ${stats.upgradeTimeGameHours} игровых ч (${share})`
        : `«${entry.nameRu}» модернизировано до Ур.${nextLevel} (${share})`,
    };
  }

  private handleBulldozeBuilding(sectorId: SectorId, buildingId: string): CommandOutcome {
    const bld = this.buildings.get(buildingId);
    if (!bld || bld.sectorId !== sectorId) {
      return { ok: false, message: "Объект не найден в вашем секторе" };
    }
    const entry = this.catalogs.buildingsById.get(bld.catalogId);

    // GDD §3.1 Eminent Domain protection: co-invested plant with private shareholders requires 100% buyout first
    if (
      entry?.ownershipContour === "co_invested_10_90" &&
      bld.cityEquityShare < 0.999 &&
      !bld.stalledAwaitingPrivate
    ) {
      return {
        ok: false,
        message:
          "Нельзя снести завод с частными акционерами без 100% выкупа акций городом (Eminent Domain)!",
      };
    }

    if (this.foreignStakes.some((f) => f.buildingId === buildingId && f.share > 0)) {
      return { ok: false, message: "У предприятия есть иностранные акционеры — сначала выкупите их доли" };
    }
    if (this.borderPosts.has(buildingId)) {
      this.borderPosts.delete(buildingId);
      this.db.deleteBorderPost(buildingId);
    }

    const reg = this.engine.getRegion(sectorId);
    if (entry) {
      const scrapRefund = mulRate(entry.buildCostLv1, 0.2 * reg.fxRatePerWcu * bld.cityEquityShare);
      reg.treasuryCashAtCb += scrapRefund;
      this.persistSectorState(sectorId);
    }

    this.buildings.delete(buildingId);
    this.db.deleteBuilding(buildingId);
    return { ok: true, message: `Объект «${entry?.nameRu ?? bld.catalogId}» снесён.` };
  }

  private handleDemolishBuilding(sectorId: SectorId, buildingId: string): CommandOutcome {
    const bld = this.buildings.get(buildingId);
    if (!bld || bld.sectorId !== sectorId) {
      return { ok: false, message: "Объект не найден в вашем секторе" };
    }
    const reg = this.engine.getRegion(sectorId);
    reg.lastMayorActivityEpochMs = Date.now();
    reg.isAiGovernor = false;

    if (bld.catalogId === "CIV-02" && bld.constructionProgress > 0) {
      const sym = currencySymbol(reg.currency);
      const entry = this.catalogs.buildingsById.get(bld.catalogId);
      const dwellings = Math.max(12, Math.round((entry?.capacityLv1 ?? 40) * bld.level));
      const comp = money(dwellings * 28_000 * reg.cpi * reg.fxRatePerWcu);
      if (reg.treasuryCashAtCb < comp) {
        return {
          ok: false,
          message: `Недостаточно средств казны для 100% выкупа жилья жильцам (Eminent Domain): нужно ${fmtSym(comp, sym)}`,
        };
      }
      reg.treasuryCashAtCb -= comp;
      reg.dwellings = Math.max(0, reg.dwellings - dwellings);
      this.engine.bookEminentDomainBuyout(sectorId, comp, "HH");
      this.persistSectorState(sectorId);
      this.buildings.delete(buildingId);
      this.db.deleteBuilding(buildingId);
      return {
        ok: true,
        message: `Снесён жилой корпус «${entry?.nameRu ?? bld.catalogId}»: жильцам выплачена 100% компенсация ${fmtSym(comp, sym)} (T → HH)`,
      };
    }

    return this.handleBulldozeBuilding(sectorId, buildingId);
  }

  private handleDemolishZone(sectorId: SectorId, zoneId: string): CommandOutcome {
    const z = this.zones.get(zoneId);
    if (!z || z.sectorId !== sectorId) {
      return { ok: false, message: "Зона не найдена в вашем секторе" };
    }
    const reg = this.engine.getRegion(sectorId);
    reg.lastMayorActivityEpochMs = Date.now();
    reg.isAiGovernor = false;
    const sym = currencySymbol(reg.currency);
    const tiles = z.width * z.depth;
    let comp = 0n;

    if (z.occupancyRatio > 0.001) {
      const district = this.ensureCity().districts.find((d) => d.zoneId === zoneId);
      const landPerTile = (district?.landValuePerTile ?? 300) * 12;
      if (z.zoneKind.startsWith("RES")) {
        const unitPrice = z.zoneKind === "RES-03" ? 172_500 : z.zoneKind === "RES-02" ? 72_000 : 33_000;
        const dwellings = tiles * (DWELLINGS_PER_RESIDENTIAL_TILE[z.zoneKind] ?? 1.5) * z.occupancyRatio;
        comp = money((dwellings * unitPrice + tiles * landPerTile) * reg.cpi * reg.fxRatePerWcu);
        if (reg.treasuryCashAtCb < comp) {
          return {
            ok: false,
            message: `Недостаточно средств казны для 100% выкупа жилья и земли у собственников (Eminent Domain): нужно ${fmtSym(comp, sym)}, доступно ${fmtSym(reg.treasuryCashAtCb, sym)}`,
          };
        }
        reg.treasuryCashAtCb -= comp;
        reg.dwellings = Math.max(0, reg.dwellings - dwellings);
        this.engine.bookEminentDomainBuyout(sectorId, comp, "HH");
      } else {
        const structPerTile = z.zoneKind.endsWith("03") ? 95_000 : z.zoneKind.endsWith("02") ? 45_000 : 18_000;
        comp = money((tiles * structPerTile * z.occupancyRatio + tiles * landPerTile) * reg.cpi * reg.fxRatePerWcu);
        if (reg.treasuryCashAtCb < comp) {
          return {
            ok: false,
            message: `Недостаточно средств казны для 100% выкупа коммерческой недвижимости (Eminent Domain): нужно ${fmtSym(comp, sym)}, доступно ${fmtSym(reg.treasuryCashAtCb, sym)}`,
          };
        }
        reg.treasuryCashAtCb -= comp;
        this.engine.bookEminentDomainBuyout(sectorId, comp, "Fk");
      }
      this.persistSectorState(sectorId);
    }

    this.zones.delete(zoneId);
    this.db.deleteZone(zoneId);
    this.lastConstruction = null;
    return {
      ok: true,
      message:
        comp > 0n
          ? `Квартал ${z.zoneKind} (${z.width}×${z.depth}) изъят по Eminent Domain и снесён: собственникам выплачено 100% стоимости (${fmtSym(comp, sym)})`
          : `Незастроенный участок ${z.zoneKind} (${z.width}×${z.depth}) снят с кадастра`,
    };
  }

  private handleUpgradeZone(
    sectorId: SectorId,
    zoneId: string,
    targetZoneKind?: ZoneKind
  ): CommandOutcome {
    const z = this.zones.get(zoneId);
    if (!z || z.sectorId !== sectorId) {
      return { ok: false, message: "Зона не найдена в вашем секторе" };
    }
    const NEXT_STEP: Partial<Record<ZoneKind, ZoneKind>> = {
      "RES-01": "RES-02",
      "RES-02": "RES-03",
      "COM-01": "COM-02",
      "COM-02": "COM-03",
      "OFF-01": "OFF-02",
    };
    const nextKind = targetZoneKind ?? NEXT_STEP[z.zoneKind];
    if (!nextKind || nextKind === z.zoneKind) {
      return { ok: false, message: `Квартал ${z.zoneKind} уже имеет максимальную плотность застройки` };
    }
    const sameFamily = nextKind.slice(0, 3) === z.zoneKind.slice(0, 3);
    const higherTier = Number(nextKind.slice(-2)) > Number(z.zoneKind.slice(-2));
    if (!sameFamily || !higherTier) {
      return { ok: false, message: `Недопустимый редевелопмент ${z.zoneKind} → ${nextKind}` };
    }

    const reg = this.engine.getRegion(sectorId);
    reg.lastMayorActivityEpochMs = Date.now();
    reg.isAiGovernor = false;
    const tiles = z.width * z.depth;
    const rezoneFee = mulRate(money(tiles * 150), reg.fxRatePerWcu);
    const sym = currencySymbol(reg.currency);
    if (reg.treasuryCashAtCb < rezoneFee) {
      return { ok: false, message: `Недостаточно средств казны на перезонирование (${fmtSym(rezoneFee, sym)})` };
    }
    reg.treasuryCashAtCb -= rezoneFee;
    this.persistSectorState(sectorId);

    const updated: ZoneDto = {
      ...z,
      zoneKind: nextKind,
      occupancyRatio: Number((z.occupancyRatio * 0.35).toFixed(4)),
    };
    this.zones.set(zoneId, updated);
    this.db.upsertZone(updated);
    this.lastConstruction = null;

    const bill = zoneMaterialBill(nextKind, Math.round(tiles * (1 - updated.occupancyRatio)));
    return {
      ok: true,
      message: `Редевелопмент квартала #${zoneId}: ${z.zoneKind} → ${nextKind}. Частным девелоперам потребуется ~${Math.round(bill.tons).toLocaleString("ru-RU")} т стройматериалов (цемент, сталь, префабы).`,
    };
  }

  private handleUpdatePolicy(
    cmd: Extract<ClientCommand, { type: "update_policy" }>
  ): CommandOutcome {
    const reg = this.engine.getRegion(cmd.sectorId);
    reg.lastMayorActivityEpochMs = Date.now();
    reg.isAiGovernor = false;
    const noticeAlerts: string[] = [];

    if (cmd.preset) {
      reg.levers.preset = cmd.preset;
      if (cmd.preset === "taylor") {
        reg.levers.useTaylorAdvisor = true;
        reg.levers.cbBondPurchaseShare = 0;
      } else if (cmd.preset === "populist") {
        reg.levers.useTaylorAdvisor = false;
        reg.levers.keyRate = 0.03;
        reg.levers.cbBondPurchaseShare = 0.8;
      } else if (cmd.preset === "hawk") {
        reg.levers.useTaylorAdvisor = false;
        reg.levers.keyRate = 0.12;
        reg.levers.cbBondPurchaseShare = 0;
      }
    }

    if (cmd.useTaylorAdvisor !== undefined) reg.levers.useTaylorAdvisor = cmd.useTaylorAdvisor;
    if (cmd.keyRate !== undefined) {
      reg.levers.keyRate = Math.max(0.01, Math.min(0.4, cmd.keyRate));
      reg.levers.useTaylorAdvisor = false;
    }
    if (cmd.reserveRequirement !== undefined) {
      reg.levers.reserveRequirement = Math.max(0, Math.min(0.2, cmd.reserveRequirement));
    }
    if (cmd.cbBondPurchaseShare !== undefined) {
      if (reg.imf.active && cmd.cbBondPurchaseShare > 0) {
        return {
          ok: false,
          message: "Меморандум МВФ запрещает прямую эмиссионную покупку гособлигаций ЦБ!",
        };
      }
      reg.levers.cbBondPurchaseShare = Math.max(0, Math.min(1, cmd.cbBondPurchaseShare));
    }
    if (cmd.swfSterilizationShare !== undefined) {
      reg.levers.swfSterilizationShare = Math.max(0, Math.min(0.8, cmd.swfSterilizationShare));
    }
    if (cmd.vatRate !== undefined) {
      reg.levers.vatRate = Math.max(0, Math.min(0.25, cmd.vatRate));
    }
    if (cmd.corpTaxRate !== undefined) {
      reg.levers.corpTaxRate = Math.max(0, Math.min(0.4, cmd.corpTaxRate));
    }
    if (cmd.cityNewPlantShare !== undefined) {
      reg.levers.cityNewPlantShare = Math.max(0.1, Math.min(1, cmd.cityNewPlantShare));
    }
    if (cmd.roadServiceLevel !== undefined) {
      const level = Math.max(0, Math.min(2, Math.round(cmd.roadServiceLevel))) as RoadServiceLevel;
      this.roadServiceLevel.set(cmd.sectorId, level);
      this.db.setMeta(`roadService:S${cmd.sectorId}`, String(level));
    }
    if (cmd.toggleDecreeId) {
      const idx = reg.levers.activeDecreeIds.indexOf(cmd.toggleDecreeId);
      if (idx >= 0) {
        reg.levers.activeDecreeIds.splice(idx, 1);
      } else {
        reg.levers.activeDecreeIds.push(cmd.toggleDecreeId);
      }
    }
    if (cmd.importDutyRate !== undefined) {
      const res = this.engine.setImportDutyWithNotice(cmd.sectorId, cmd.importDutyRate);
      if (!res.appliedImmediately && res.notice) {
        noticeAlerts.push(res.notice.descriptionRu);
        this.pushSystemChat(`⚠️ ОКНО УВЕДОМЛЕНИЯ: ${res.notice.descriptionRu}`);
        return {
          ok: true,
          message: res.notice.descriptionRu,
          noticeAlerts,
        };
      }
    }

    return { ok: true, message: `Макроэкономические рычаги Сектора ${cmd.sectorId} обновлены.` };
  }

  private handleSendChat(cmd: Extract<ClientCommand, { type: "send_chat" }>): CommandOutcome {
    const trimmed = cmd.text.trim().slice(0, 500);
    if (!trimmed) return { ok: false, message: "Пустое сообщение" };
    const reg = this.engine.getRegion(cmd.senderSector);
    const msg: ChatMessageDto = {
      id: this.nextId("chat"),
      timestampIso: new Date().toISOString(),
      senderSector: cmd.senderSector,
      senderName: `${reg.mayorDisplayName} (S${cmd.senderSector})`,
      channel: cmd.channel,
      text: trimmed,
    };
    this.recentChat.push(msg);
    if (this.recentChat.length > 80) this.recentChat.shift();
    this.db.insertChat(msg);
    return { ok: true, message: "Сообщение отправлено" };
  }

  private handleAdminTimeSkip(jump: "1h" | "1d" | "1mo" | "1yr"): CommandOutcome {
    const secondsByJump: Record<typeof jump, number> = {
      "1h": 3600,
      "1d": 86_400,
      "1mo": 86_400 * 30,
      "1yr": 86_400 * 30 * 12,
    };
    const alerts = this.advanceGameSeconds(secondsByJump[jump]);
    const cal = computeDualCalendar(this.totalGameSeconds, this.catalogs.unitsAndTime.timeBase);
    return {
      ok: true,
      message: `Перемотка +${jump} выполнена -> Год ${cal.economicYear}, Месяц ${cal.economicMonth}, День ${cal.economicDayOfMonth}. Все матрицы сведены с ошибкой 0.00!`,
      noticeAlerts: alerts,
    };
  }

  private handleAdminEmergency(
    sectorId: SectorId,
    emergencyId: ActiveEmergencyDto["emergencyId"]
  ): CommandOutcome {
    const spec = CANONICAL_EMERGENCIES.find((e) => e.id === emergencyId);
    if (!spec) return { ok: false, message: `Неизвестное ЧП: ${emergencyId}` };

    // Strike the sector's own city when it has one, otherwise its profile deposit
    const target =
      [...this.buildings.values()].find((b) => b.sectorId === sectorId && b.constructionProgress >= 1) ??
      undefined;
    const deposit = this.map.deposits.find((d) => d.sectorId === sectorId);
    const tileX = target ? Math.round(target.tileX + target.width / 2) : deposit ? deposit.tileX + 6 : 500;
    const tileY = target ? Math.round(target.tileY + target.depth / 2) : deposit ? deposit.tileY + 6 : 500;

    const text = this.spawnEmergency({
      emergencyId,
      sectorId,
      tileX,
      tileY,
      targetRef: target?.id ?? null,
      causeRu: "запущено из Бог-режима",
    });
    this.pushSystemChat(text);
    return { ok: true, message: text };
  }

  private evaluateStarterQuests(
    sectorId: SectorId,
    constructionSector: SectorConstructionStatsDto | undefined,
    cityResidents: number
  ): StarterQuestStepDto[] {
    const reg = this.engine.getRegion(sectorId);
    const claimed = this.claimedQuests.get(sectorId) ?? new Set<StarterQuestStepId>();

    // Step 1: Connect starter road to external highway (S1–S2) or tunnel exit (S3–S5)
    const step1Done = Boolean(constructionSector?.gatewayImportOpen);

    // Step 2: Paint first residential zone (RES-01 or RES-02) adjacent to a road
    const sectorRoadSegs = [...this.segments.values()].filter(
      (s) => s.sectorId === sectorId && !s.id.startsWith("GW-STUB-") && isRoadKind(s.kind)
    );
    const roadGraph = buildNetworkGraph(sectorRoadSegs, "road");
    const step2Done =
      roadGraph.edges.length > 0 &&
      [...this.zones.values()].some(
        (z) =>
          z.sectorId === sectorId &&
          (z.zoneKind === "RES-01" || z.zoneKind === "RES-02") &&
          Boolean(locateRectOnGraph(roadGraph, { x: z.x, y: z.y, width: z.width, depth: z.depth }, 3))
      );

    // Step 3: Build Water Intake (UTL-01) and starter power station (ENG-01..04)
    const sectorBlds = [...this.buildings.values()].filter((b) => b.sectorId === sectorId);
    const hasWater = sectorBlds.some((b) => b.catalogId === "UTL-01");
    const hasPower = sectorBlds.some((b) =>
      b.catalogId === "ENG-01" ||
      b.catalogId === "ENG-02" ||
      b.catalogId === "ENG-03" ||
      b.catalogId === "ENG-04"
    );
    const step3Done = hasWater && hasPower;

    // Step 4: Reach 100 settled citizens
    const step4Done = cityResidents >= 100;

    const defs: ReadonlyArray<{
      stepId: StarterQuestStepId;
      titleRu: string;
      descriptionRu: string;
      rewardWcuUnits: number;
      completed: boolean;
    }> = [
      {
        stepId: 1,
        titleRu: "1. Внешняя артерия снабжения",
        descriptionRu:
          sectorId <= 2
            ? "Протяните улицу от вашего сектора к внешнему шоссе на севере, чтобы открыть импорт стройматериалов."
            : "Протяните улицу к выходу из подводного туннеля, чтобы открыть импорт стройматериалов.",
        rewardWcuUnits: 250_000,
        completed: step1Done,
      },
      {
        stepId: 2,
        titleRu: "2. Первый жилой квартал",
        descriptionRu: "Разметьте жилую зону (RES-01 Коттеджи или RES-02 Кварталы) вплотную к дороге.",
        rewardWcuUnits: 300_000,
        completed: step2Done,
      },
      {
        stepId: 3,
        titleRu: "3. Вода и базовая энергетика",
        descriptionRu: "Постройте Водозаборную станцию (UTL-01) у воды и электростанцию/подстанцию (ENG-01..04).",
        rewardWcuUnits: 500_000,
        completed: step3Done,
      },
      {
        stepId: 4,
        titleRu: "4. Первые 100 горожан",
        descriptionRu: "Обеспечьте застройку участков девелоперами и заселите первые 100 жителей в ваш город.",
        rewardWcuUnits: 750_000,
        completed: step4Done,
      },
    ];

    return defs.map((d) => ({
      stepId: d.stepId,
      titleRu: d.titleRu,
      descriptionRu: d.descriptionRu,
      rewardWcuUnits: d.rewardWcuUnits,
      rewardLocalMinor: mulRate(money(d.rewardWcuUnits), reg.fxRatePerWcu).toString(),
      completed: d.completed,
      claimed: claimed.has(d.stepId),
    }));
  }

  private handleClaimQuestReward(
    cmd: Extract<ClientCommand, { type: "claim_quest_reward" }>
  ): CommandOutcome {
    const reg = this.engine.getRegion(cmd.sectorId);
    reg.lastMayorActivityEpochMs = Date.now();
    const city = this.ensureCity();
    const construction = this.constructionSnapshot();
    const constructionSec = construction.sectors.find((c) => c.sectorId === cmd.sectorId);
    const cityResidents = city.sectors.find((c) => c.sectorId === cmd.sectorId)?.residents ?? 0;
    const steps = this.evaluateStarterQuests(cmd.sectorId, constructionSec, cityResidents);
    const target = steps.find((s) => s.stepId === cmd.stepId);

    if (!target) {
      return { ok: false, message: "Неизвестный этап стартового квеста" };
    }
    if (target.claimed) {
      return { ok: false, message: `Награда за этап «${target.titleRu}» уже получена` };
    }
    if (!target.completed) {
      return { ok: false, message: `Условие этапа «${target.titleRu}» ещё не выполнено` };
    }

    const rewardLocal = BigInt(target.rewardLocalMinor);
    reg.treasuryCashAtCb += rewardLocal;
    this.engine.bookLedgerEntry(cmd.sectorId, [
      "Starter quest grant (World -> T)",
      0n,
      0n,
      0n,
      rewardLocal,
      0n,
      0n,
      -rewardLocal,
    ]);

    let claimed = this.claimedQuests.get(cmd.sectorId);
    if (!claimed) {
      claimed = new Set<StarterQuestStepId>();
      this.claimedQuests.set(cmd.sectorId, claimed);
    }
    claimed.add(cmd.stepId);
    this.db.setMeta(`quests:S${cmd.sectorId}`, JSON.stringify([...claimed]));
    this.persistSectorState(cmd.sectorId);

    const sym = currencySymbol(reg.currency);
    return {
      ok: true,
      message: `🎯 Квест выполнен («${target.titleRu}»): грант ${fmtSym(rewardLocal, sym)} зачислен в казну (World -> T)!`,
    };
  }

  private computeSectorStage(households: number): string {
    let stage = "S0";
    for (const st of this.catalogs.stages) {
      if (households >= st.minHouseholds) {
        stage = st.stage;
      }
    }
    return stage;
  }

  private computeSectorPower(sectorId: SectorId): { supplyMw: number; demandMw: number } {
    let supplyMw = 35; // Starter gateway substation capacity
    let demandMw = 8;

    for (const b of this.buildings.values()) {
      if (b.sectorId !== sectorId || b.stalledAwaitingPrivate) continue;
      const cat = this.catalogs.buildingsById.get(b.catalogId);
      if (!cat) continue;
      const stats = computeBuildingAtLevel(cat, this.catalogs.levelCurves, b.level);
      if (GENERATOR_IDS.has(cat.id)) {
        // Without pipeline gas, ENG-02 switches to backup mazut (fuel oil) at 45% output capacity
        const gasShare = this.gas?.turbineSupply.get(b.id) ?? 0;
        const fuel = cat.id === "ENG-02" ? gasShare + (1 - gasShare) * 0.45 : 1;
        if (b.constructionProgress >= 1) supplyMw += Math.max(cat.capacityLv1 * b.level, Math.abs(stats.powerMw)) * fuel;
      } else if (cat.prefix !== "ENG") {
        demandMw += Math.max(0, stats.powerMw);
      }
    }
    for (const z of this.zones.values()) {
      if (z.sectorId !== sectorId) continue;
      demandMw += z.width * z.depth * 0.12 * z.occupancyRatio;
    }
    return {
      supplyMw: Math.round(supplyMw * 10) / 10,
      demandMw: Math.round(demandMw * 10) / 10,
    };
  }

  public getSnapshot(): WorldSnapshotDto {
    const traffic = this.ensureTraffic();
    const city = this.ensureCity();
    const construction = this.constructionSnapshot();
    const megaprojects = this.megaprojectList();
    const cal = computeDualCalendar(this.totalGameSeconds, this.catalogs.unitsAndTime.timeBase);
    const seasonDay = Math.min(30, Math.floor(this.totalGameSeconds / 86_400) + 1);

    // Compute 1,000-pt Hegemony scores across all 5 sectors
    const hegemonyMetrics = SECTOR_IDS.map((sectorId) => {
      const reg = this.engine.getRegion(sectorId);
      const rep = reg.lastReport;
      const households = Math.round(reg.classes.reduce((s, c) => s + c.households, 0));
      const sectorBuildings = [...this.buildings.values()].filter((b) => b.sectorId === sectorId);
      const tier34Count = sectorBuildings.filter((b) => {
        const c = this.catalogs.buildingsById.get(b.catalogId);
        return c?.prefix === "CMP" || c?.prefix === "ASM";
      }).length;

      const megaShareOf = (catId: MegaprojectCatalogId) => {
        const p = megaprojects.find((m) => m.catalogId === catId && m.status === "operational");
        return p?.stakes.find((st) => st.sectorId === sectorId)?.share ?? 0;
      };
      const meg01Share = megaShareOf("MEG-01");
      const meg03Share = megaShareOf("MEG-03");
      const meg04Share = megaShareOf("MEG-04");
      const gdpBoostMult = 1 + meg03Share * 0.08 + meg04Share * 0.1;

      return {
        sectorId,
        gdpInWcu: (rep?.gdpWcu ?? 250_000_000) * gdpBoostMult,
        swfAndReservesInWcu: toUnits(reg.fxReservesWcu + reg.swfBalanceWcu),
        megaprojectEquityShare:
          megaprojects.length > 0
            ? megaprojects.reduce((t, p) => t + (p.stakes.find((st) => st.sectorId === sectorId)?.share ?? 0), 0) / megaprojects.length
            : 0,
        households,
        happinessIndex: reg.happinessIndex,
        // Sheet 25 Table 5 real-estate value per tile = 250 x GDD land value ($120..$6,000)
        avgLandValueUnits:
          (city.sectors.find((c) => c.sectorId === sectorId)?.avgLandValuePerTile ?? 0) * 250 ||
          120_000 + sectorBuildings.length * 4_500,
        freightAndTransitVolumeTons:
          (25_000 + this.segments.size * 1_200 + (traffic.state.sectors.find((t) => t.sectorId === sectorId)?.truckTripsPerHour ?? 0) * 720 * 25) *
          (1 + meg01Share * 0.5),
        tier3And4OutputInWcu: (tier34Count + 1) * 15_000_000 * (1 + meg04Share * 0.15),
        avgProductQualityStars: Math.min(5, 3 + tier34Count * 0.25 + meg04Share * 0.75),
      };
    });
    const hegemonyBySector = new Map(
      computeHegemonyScores(hegemonyMetrics).map((h) => [h.sectorId, h])
    );

    let invariantAllZero = true;
    const sectors: SectorSummaryDto[] = SECTOR_IDS.map((sectorId) => {
      const reg = this.engine.getRegion(sectorId);
      const rep = reg.lastReport;
      const households = Math.round(reg.classes.reduce((s, c) => s + c.households, 0));
      const { rating } = computeCreditRating(reg.debtToRevenueRatio);
      const lastAnnInflation =
        rep?.annualInflation ??
        (reg.inflationHistory[reg.inflationHistory.length - 1] ?? 0.0025) * 12;
      const power = this.effectivePower(sectorId);
      const sym = currencySymbol(reg.currency);

      const maxErr = rep
        ? maxBig(
            maxBig(rep.invariants.maxRowError, rep.invariants.maxColError),
            maxBig(
              absBig(rep.invariants.cbColumnIndependentSum),
              rep.invariants.moneyDecompositionDiff
            )
          )
        : 0n;
      const valid = rep ? rep.invariants.valid && maxErr === 0n : true;
      if (!valid) invariantAllZero = false;

      const lastMatrix: SerializedMatrixRow[] = (rep?.matrix ?? []).map((row) => ({
        label: row[0],
        cellsMinor: [
          row[1].toString(),
          row[2].toString(),
          row[3].toString(),
          row[4].toString(),
          row[5].toString(),
          row[6].toString(),
          row[7].toString(),
        ],
      }));

      return {
        sectorId,
        occupied: this.occupiedBySector.get(sectorId) ?? false,
        cityName: reg.cityName,
        mayorName: reg.mayorDisplayName,
        isAiGovernor: reg.isAiGovernor,
        currency: reg.currency,
        currencySymbol: sym,
        fxRatePerWcu: Number(reg.fxRatePerWcu.toFixed(4)),
        stage: this.computeSectorStage(households),
        treasuryBalanceMinor: reg.treasuryCashAtCb.toString(),
        gdpWcu: Math.round(rep?.gdpWcu ?? 0),
        annualInflation: Number(lastAnnInflation.toFixed(4)),
        keyRate: Number(reg.levers.keyRate.toFixed(4)),
        reserveRequirement: reg.levers.reserveRequirement,
        cbBondPurchaseShare: reg.levers.cbBondPurchaseShare,
        swfSterilizationShare: reg.levers.swfSterilizationShare,
        swfBalanceWcuMinor: reg.swfBalanceWcu.toString(),
        vatRate: reg.levers.vatRate,
        corpTaxRate: reg.levers.corpTaxRate,
        importDutyRate: reg.levers.importDutyRate,
        creditRating: rating,
        debtToRevenue: Number(reg.debtToRevenueRatio.toFixed(3)),
        imfActive: reg.imf.active,
        imfApprovedWcuMinor: reg.imf.totalApprovedWcu.toString(),
        imfDebtWcuMinor: reg.imf.debtPrincipalWcu.toString(),
        imfTranchesDisbursed: reg.imf.tranchesDisbursed,
        households,
        citizens: Math.round(households * 2.2),
        happinessIndex: Number(reg.happinessIndex.toFixed(1)),
        hardshipShare: Number(reg.hardshipShare.toFixed(4)),
        powerDemandMw: power.demandMw,
        powerSupplyMw: power.supplyMw,
        activeDecreeIds: [...reg.levers.activeDecreeIds],
        invariantValid: valid,
        maxErrorMinor: maxErr.toString(),
        hegemony: hegemonyBySector.get(sectorId)!,
        lastMatrix,
        quests: this.evaluateStarterQuests(
          sectorId,
          construction.sectors.find((c) => c.sectorId === sectorId),
          city.sectors.find((c) => c.sectorId === sectorId)?.residents ?? 0
        ),
      };
    });

    return {
      worldId: this.worldId,
      seasonDay,
      calendar: cal,
      invariantAllZero,
      sectors,
      segments: [...this.segments.values()],
      buildings: [...this.buildings.values()].map((b) => {
        const evalLv = city.buildingLandValues.get(b.id);
        const lv = evalLv?.landValue ?? 50;
        return { ...b, landValue: lv, districtClass: evalLv?.districtClass ?? districtClassForScore(lv) };
      }),
      zones: [...this.zones.values()].map((z) => {
        const evalLv = city.zoneLandValues.get(z.id);
        const lv = evalLv?.landValue ?? 50;
        return { ...z, landValue: lv, districtClass: evalLv?.districtClass ?? districtClassForScore(lv) };
      }),
      emergencies: this.emergencies.map((e) => ({ ...e, statusRu: this.emergencyStatusRu(e) })),
      recentChat: [...this.recentChat],
      trafficVersion: this.trafficVersion,
      busRoutes: [...this.busRoutes.values()],
      transport: traffic.state.sectors,
      construction: construction.sectors,
      zoneSites: construction.zoneSites,
      districts: city.districts,
      city: city.sectors,
      autos: this.autoStats,
      advisors: sectors.map((sector) => ({
        sectorId: sector.sectorId,
        advisors: this.advisorsFor(sector, traffic, construction, city),
      })),
      borderPosts: [...this.borderPosts.values()],
      borderStats: this.borderStats,
      gas: this.gas?.sectors ?? [],
      powerRing: this.powerRing(),
      megaprojects,
      exchange: this.listedCompanies(),
      pendingTakeovers: [...this.pendingTakeovers],
    };
  }

  private advisorsFor(
    sector: SectorSummaryDto,
    traffic: TrafficComputation,
    construction: { sectors: SectorConstructionStatsDto[] },
    city: CityModelResult
  ): AdvisorDto[] {
    const sid = sector.sectorId;
    return buildAdvisors({
      sector,
      city: city.sectors.find((c) => c.sectorId === sid),
      transport: traffic.state.sectors.find((t) => t.sectorId === sid),
      construction: construction.sectors.find((c) => c.sectorId === sid),
      autos: this.autoStats.find((a) => a.sectorId === sid),
      emergencies: this.emergencies.filter((e) => e.sectorId === sid),
      hasBuilding: (catalogId) =>
        [...this.buildings.values()].some((b) => b.sectorId === sid && b.catalogId === catalogId),
    });
  }

  public close(): void {
    this.db.close();
  }
}
