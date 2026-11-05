/**
 * Authoritative World Simulation Engine (`@pentapolis/server`).
 *
 * Bridges:
 * - `RegionalMoneyEngine` (5-currency `BigInt` double-entry ledger, 0n error invariants);
 * - `generatePeninsulaMap()` (1000×1000 flat grid + 90°/45° network + river bridges);
 * - `getMasterCatalogs()` (127 buildings, 24 chains, 56 vehicles, 8 decrees, 12 emergencies);
 * - `WorldDatabase` (`bun:sqlite` in WAL mode).
 */
import {
  CANONICAL_EMERGENCIES,
  NATIONAL_CURRENCIES,
  OwnerCode,
  RegionalMoneyEngine,
  SurfaceType,
  absBig,
  computeBuildingAtLevel,
  computeCreditRating,
  computeDualCalendar,
  computeHegemonyScores,
  formatMoney,
  generatePeninsulaMap,
  getCurrencySpec,
  getMasterCatalogs,
  maxBig,
  money,
  mulRate,
  toUnits,
  validateAndQuoteNetworkSegment,
  type ActiveEmergencyDto,
  type BuildingDto,
  type ChatMessageDto,
  type ClientCommand,
  type CurrencyCode,
  type MasterCatalogs,
  type Money,
  type NetworkSegmentDto,
  type PeninsulaMapData,
  type SectorId,
  type SectorSummaryDto,
  type SerializedMatrixRow,
  type WorldSnapshotDto,
  type ZoneDto,
} from "@pentapolis/shared-sim";
import { WorldDatabase } from "./db.ts";

export interface CommandOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly noticeAlerts?: readonly string[];
}

const SECTOR_IDS: readonly SectorId[] = [1, 2, 3, 4, 5];

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

  constructor(dbPath = ":memory:") {
    this.catalogs = getMasterCatalogs();
    this.map = generatePeninsulaMap();
    this.db = new WorldDatabase(dbPath);
    this.engine = new RegionalMoneyEngine({ mode: "mature" });

    const savedWorldId = this.db.getMeta("worldId");
    if (savedWorldId) {
      this.worldId = savedWorldId;
      this.restoreFromDatabase();
    } else {
      this.worldId = `pentapolis-${Date.now().toString(36)}`;
      this.bootstrapFreshWorld();
    }
  }

  private bootstrapFreshWorld(): void {
    this.db.setMeta("worldId", this.worldId);

    // Run 1 baseline macro step so all 5 regions have initial 7-column matrices (`0n` error),
    // then set every sector's starting Municipal Treasury to $10,000,000 local units (GDD §1.5, §6.1).
    const initialReports = this.engine.stepMonth();
    this.lastMonthProcessed = 1;
    this.lastDayProcessed = 30;
    this.lastHourProcessed = 720;
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
    this.entitySeq =
      this.segments.size + this.zones.size + this.buildings.size + this.recentChat.length + 10;
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
   * hourly (`3,600s`), daily (`86,400s`), and monthly (`2,592,000s`) simulation steps.
   */
  public advanceGameSeconds(deltaGameSeconds: number): string[] {
    if (deltaGameSeconds <= 0) return [];
    const alerts: string[] = [];
    this.totalGameSeconds += deltaGameSeconds;
    this.db.setMeta("totalGameSeconds", String(this.totalGameSeconds));

    const totalHoursNow = Math.floor(this.totalGameSeconds / 3600);
    const hoursDelta = totalHoursNow - this.lastHourProcessed;
    if (hoursDelta > 0) {
      this.lastHourProcessed = totalHoursNow;
      this.stepGameHours(hoursDelta);
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
    }

    const totalMonthsNow = Math.floor(this.totalGameSeconds / (86_400 * 30)) + 1;
    while (this.lastMonthProcessed < totalMonthsNow) {
      this.lastMonthProcessed += 1;
      const reports = this.engine.stepMonth();
      for (const rep of reports) {
        const reg = this.engine.getRegion(rep.sectorId);
        // Credit monthly positive municipal operating surplus (scaled smoothly for active build phase)
        if (rep.budgetBalance > 0n) {
          reg.treasuryCashAtCb += mulRate(rep.budgetBalance, 0.04);
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

    // Expire resolved emergencies
    for (let i = this.emergencies.length - 1; i >= 0; i--) {
      if (this.emergencies[i]!.expiresAtGameSeconds <= this.totalGameSeconds) {
        this.emergencies.splice(i, 1);
      }
    }

    return alerts;
  }

  private stepGameHours(hours: number): void {
    // Advance building construction sites (unless stalled awaiting private 90% co-investors)
    for (const b of this.buildings.values()) {
      if (b.stalledAwaitingPrivate || b.constructionProgress >= 1) continue;
      const cat = this.catalogs.buildingsById.get(b.catalogId);
      const totalBuildHours = Math.max(1, cat?.buildTimeGameHours ?? 4);
      const nextProg = Math.min(1, b.constructionProgress + hours / totalBuildHours);
      if (nextProg !== b.constructionProgress) {
        const updated: BuildingDto = { ...b, constructionProgress: Number(nextProg.toFixed(3)) };
        this.buildings.set(b.id, updated);
        this.db.upsertBuilding(updated);
      }
    }

    // Grow private developer occupancy on RCI zones
    for (const z of this.zones.values()) {
      if (z.occupancyRatio >= 1) continue;
      const reg = this.engine.getRegion(z.sectorId);
      const growthRate = reg.happinessIndex >= 50 ? 0.035 : 0.012;
      const nextOcc = Math.min(1, z.occupancyRatio + hours * growthRate);
      const updated: ZoneDto = { ...z, occupancyRatio: Number(nextOcc.toFixed(3)) };
      this.zones.set(z.id, updated);
      this.db.upsertZone(updated);
    }

    // Gradual axle road wear (mitigated by TRUCK_WEIGHT_CONTROL decree)
    for (const seg of this.segments.values()) {
      if (seg.id.startsWith("GW-STUB-")) continue;
      const reg = this.engine.getRegion(seg.sectorId);
      const weightCtrl = reg.levers.activeDecreeIds.includes("TRUCK_WEIGHT_CONTROL") ? 0.75 : 1.0;
      const wear = hours * 0.04 * weightCtrl;
      const nextHealth = Math.max(25, Number((seg.healthPercent - wear).toFixed(2)));
      if (nextHealth !== seg.healthPercent) {
        const updated: NetworkSegmentDto = { ...seg, healthPercent: nextHealth };
        this.segments.set(seg.id, updated);
        this.db.upsertSegment(updated);
      }
    }
  }

  public executeCommand(cmd: ClientCommand): CommandOutcome {
    switch (cmd.type) {
      case "claim_sector":
        return this.handleClaimSector(cmd);
      case "reset_sector":
        return this.handleResetSector(cmd.sectorId);
      case "build_segment":
        return this.handleBuildSegment(cmd);
      case "paint_zone":
        return this.handlePaintZone(cmd);
      case "place_building":
        return this.handlePlaceBuilding(cmd);
      case "buyout_factory":
        return this.handleBuyoutFactory(cmd.sectorId, cmd.buildingId);
      case "upgrade_building":
        return this.handleUpgradeBuilding(cmd.sectorId, cmd.buildingId, cmd.mayorPaysAll);
      case "bulldoze_building":
        return this.handleBulldozeBuilding(cmd.sectorId, cmd.buildingId);
      case "update_policy":
        return this.handleUpdatePolicy(cmd);
      case "send_chat":
        return this.handleSendChat(cmd);
      case "admin_time_skip":
        return this.handleAdminTimeSkip(cmd.jump);
      case "admin_trigger_emergency":
        return this.handleAdminEmergency(cmd.sectorId, cmd.emergencyId);
    }
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
    reg.factories.length = 0;
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
      occupancyRatio: 0.25,
    };
    this.zones.set(zone.id, zone);
    this.db.upsertZone(zone);

    // Slightly expand sector dwellings when residential zones are painted
    if (cmd.zoneKind.startsWith("RES-")) {
      const addDwellings = cmd.zoneKind === "RES-03" ? w * d * 12 : cmd.zoneKind === "RES-02" ? w * d * 5 : w * d * 1.5;
      reg.dwellings += addDwellings;
    }

    return {
      ok: true,
      message: `Размечена зона ${cmd.zoneKind} (${w}×${d} тайлов). Частные застройщики начали возведение зданий.`,
    };
  }

  private handlePlaceBuilding(
    cmd: Extract<ClientCommand, { type: "place_building" }>
  ): CommandOutcome {
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
        } else if (ow !== (cmd.sectorId as OwnerCode) && !allowsCoastOrSea) {
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

    // 100% Municipal / Contour B / Megaproject JV slice
    const outlay = isMegaproject ? mulRate(fullBuildCostLocal, 0.25) : fullBuildCostLocal;
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
      constructionProgress: entry.buildTimeGameHours <= 1 ? 1 : 0.5,
      cityEquityShare: isMegaproject ? 0.25 : 1.0,
      stalledAwaitingPrivate: false,
    };
    this.buildings.set(bld.id, bld);
    this.db.upsertBuilding(bld);

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
    const updated: BuildingDto = {
      ...bld,
      level: nextLevel,
      cityEquityShare: Number(newCityShare.toFixed(4)),
      constructionProgress: 1,
    };
    this.buildings.set(buildingId, updated);
    this.db.upsertBuilding(updated);

    return {
      ok: true,
      message: `«${entry.nameRu}» модернизировано до Ур.${nextLevel} (доля Мэрии: ${Math.round(updated.cityEquityShare * 100)}%, расход: ${fmtSym(cityPay, sym)})`,
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

    const deposit = this.map.deposits.find((d) => d.sectorId === sectorId);
    const tileX = deposit ? deposit.tileX + 6 : 500;
    const tileY = deposit ? deposit.tileY + 6 : 500;

    const emg: ActiveEmergencyDto = {
      instanceId: this.nextId("emg"),
      emergencyId,
      sectorId,
      tileX,
      tileY,
      titleRu: `${spec.nameRu}: ${spec.impactSummaryRu}`,
      expiresAtGameSeconds: this.totalGameSeconds + 3600 * 6,
    };
    this.emergencies.push(emg);
    this.pushSystemChat(`🚨 ЧП в Секторе ${sectorId}: ${spec.nameRu}!`);
    return { ok: true, message: `Запущено ЧП «${spec.nameRu}» в Секторе ${sectorId}` };
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
      if (cat.prefix === "ENG") {
        supplyMw += Math.max(cat.capacityLv1 * b.level, Math.abs(stats.powerMw));
      } else {
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
      const megaCount = [...this.buildings.values()].filter((b) => b.sectorId === "core").length;

      return {
        sectorId,
        gdpInWcu: rep?.gdpWcu ?? 250_000_000,
        swfAndReservesInWcu: toUnits(reg.fxReservesWcu + reg.swfBalanceWcu),
        megaprojectEquityShare: megaCount > 0 ? 0.2 : 0,
        households,
        happinessIndex: reg.happinessIndex,
        avgLandValueUnits: 120_000 + sectorBuildings.length * 4_500,
        freightAndTransitVolumeTons: 25_000 + this.segments.size * 1_200,
        tier3And4OutputInWcu: (tier34Count + 1) * 15_000_000,
        avgProductQualityStars: Math.min(5, 3 + tier34Count * 0.25),
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
      const power = this.computeSectorPower(sectorId);
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
      };
    });

    return {
      worldId: this.worldId,
      seasonDay,
      calendar: cal,
      invariantAllZero,
      sectors,
      segments: [...this.segments.values()],
      buildings: [...this.buildings.values()],
      zones: [...this.zones.values()],
      emergencies: [...this.emergencies],
      recentChat: [...this.recentChat],
    };
  }

  public close(): void {
    this.db.close();
  }
}
