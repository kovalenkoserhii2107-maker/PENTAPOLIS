/**
 * Authoritative Embedded SQLite Persistence Layer (`bun:sqlite`, WAL mode).
 *
 * Persists world clock, sector claims & sovereign currencies, placed 90°/45° network segments,
 * RCI zones, placed buildings (including 10%/90% co-invested equity states), monthly double-entry
 * audit snapshots, Council / bilateral Mayor chat messages and licensed bus routes.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  BuildingDto,
  BusRouteDto,
  ChatMessageDto,
  CurrencyCode,
  NetworkKind,
  NetworkSegmentDto,
  SectorId,
  ZoneDto,
  ZoneKind,
} from "@pentapolis/shared-sim";

export interface StoredSectorClaim {
  readonly sectorId: SectorId;
  readonly occupied: boolean;
  readonly cityName: string;
  readonly mayorName: string;
  readonly currency: CurrencyCode;
  readonly treasuryMinor: string;
  readonly claimedAtMs: number;
}

export class WorldDatabase {
  public readonly db: Database;

  constructor(dbPath = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS world_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sector_claims (
        sector_id INTEGER PRIMARY KEY,
        occupied INTEGER NOT NULL,
        city_name TEXT NOT NULL,
        mayor_name TEXT NOT NULL,
        currency TEXT NOT NULL,
        treasury_minor TEXT NOT NULL,
        claimed_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS network_segments (
        id TEXT PRIMARY KEY,
        sector_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        from_x INTEGER NOT NULL,
        from_y INTEGER NOT NULL,
        to_x INTEGER NOT NULL,
        to_y INTEGER NOT NULL,
        has_bridge INTEGER NOT NULL,
        is_flyover INTEGER NOT NULL,
        health_percent REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS zones (
        id TEXT PRIMARY KEY,
        sector_id INTEGER NOT NULL,
        zone_kind TEXT NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        width INTEGER NOT NULL,
        depth INTEGER NOT NULL,
        occupancy_ratio REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS buildings (
        id TEXT PRIMARY KEY,
        catalog_id TEXT NOT NULL,
        sector_id TEXT NOT NULL,
        tile_x INTEGER NOT NULL,
        tile_y INTEGER NOT NULL,
        width INTEGER NOT NULL,
        depth INTEGER NOT NULL,
        orientation_deg INTEGER NOT NULL,
        level INTEGER NOT NULL,
        construction_progress REAL NOT NULL,
        city_equity_share REAL NOT NULL,
        stalled_awaiting_private INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bus_routes (
        id TEXT PRIMARY KEY,
        sector_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        operator_name TEXT NOT NULL,
        stop_building_ids TEXT NOT NULL,
        fleet_size INTEGER NOT NULL,
        vehicle_type_id TEXT NOT NULL,
        license_fee_monthly_minor TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        timestamp_iso TEXT NOT NULL,
        sender_sector TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        channel TEXT NOT NULL,
        text TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ledger_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        month INTEGER NOT NULL,
        sector_id INTEGER NOT NULL,
        currency TEXT NOT NULL,
        fx_rate REAL NOT NULL,
        gdp_wcu REAL NOT NULL,
        invariant_valid INTEGER NOT NULL,
        max_error_minor TEXT NOT NULL,
        created_at_iso TEXT NOT NULL
      );
    `);
  }

  public getJournalMode(): string {
    const row = this.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode;").get();
    return row?.journal_mode ?? "unknown";
  }

  public getMeta(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM world_meta WHERE key = ?1")
      .get(key);
    return row?.value ?? null;
  }

  public setMeta(key: string, value: string): void {
    this.db
      .query("INSERT INTO world_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  public loadSectorClaims(): StoredSectorClaim[] {
    const rows = this.db
      .query<
        {
          sector_id: number;
          occupied: number;
          city_name: string;
          mayor_name: string;
          currency: string;
          treasury_minor: string;
          claimed_at_ms: number;
        },
        []
      >("SELECT * FROM sector_claims ORDER BY sector_id ASC")
      .all();

    return rows.map((r) => ({
      sectorId: r.sector_id as SectorId,
      occupied: r.occupied === 1,
      cityName: r.city_name,
      mayorName: r.mayor_name,
      currency: r.currency as CurrencyCode,
      treasuryMinor: r.treasury_minor,
      claimedAtMs: r.claimed_at_ms,
    }));
  }

  public saveSectorClaim(claim: StoredSectorClaim): void {
    this.db
      .query(`
        INSERT INTO sector_claims (sector_id, occupied, city_name, mayor_name, currency, treasury_minor, claimed_at_ms)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(sector_id) DO UPDATE SET
          occupied = excluded.occupied,
          city_name = excluded.city_name,
          mayor_name = excluded.mayor_name,
          currency = excluded.currency,
          treasury_minor = excluded.treasury_minor,
          claimed_at_ms = excluded.claimed_at_ms
      `)
      .run(
        claim.sectorId,
        claim.occupied ? 1 : 0,
        claim.cityName,
        claim.mayorName,
        claim.currency,
        claim.treasuryMinor,
        claim.claimedAtMs
      );
  }

  public loadSegments(): NetworkSegmentDto[] {
    const rows = this.db
      .query<
        {
          id: string;
          sector_id: number;
          kind: string;
          from_x: number;
          from_y: number;
          to_x: number;
          to_y: number;
          has_bridge: number;
          is_flyover: number;
          health_percent: number;
        },
        []
      >("SELECT * FROM network_segments")
      .all();

    return rows.map((r) => ({
      id: r.id,
      sectorId: r.sector_id as SectorId,
      kind: r.kind as NetworkKind,
      fromX: r.from_x,
      fromY: r.from_y,
      toX: r.to_x,
      toY: r.to_y,
      hasBridge: r.has_bridge === 1,
      isFlyover: r.is_flyover === 1,
      healthPercent: r.health_percent,
    }));
  }

  public upsertSegment(seg: NetworkSegmentDto): void {
    this.db
      .query(`
        INSERT INTO network_segments (id, sector_id, kind, from_x, from_y, to_x, to_y, has_bridge, is_flyover, health_percent)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(id) DO UPDATE SET health_percent = excluded.health_percent
      `)
      .run(
        seg.id,
        seg.sectorId,
        seg.kind,
        seg.fromX,
        seg.fromY,
        seg.toX,
        seg.toY,
        seg.hasBridge ? 1 : 0,
        seg.isFlyover ? 1 : 0,
        seg.healthPercent
      );
  }

  public deleteSectorEntities(sectorId: SectorId, keepSegmentIdPrefix = "GW-STUB-"): void {
    this.db
      .query("DELETE FROM network_segments WHERE sector_id = ?1 AND id NOT LIKE ?2")
      .run(sectorId, `${keepSegmentIdPrefix}%`);
    this.db.query("DELETE FROM zones WHERE sector_id = ?1").run(sectorId);
    this.db.query("DELETE FROM buildings WHERE sector_id = ?1").run(String(sectorId));
    this.db.query("DELETE FROM bus_routes WHERE sector_id = ?1").run(sectorId);
  }

  public loadBusRoutes(): BusRouteDto[] {
    const rows = this.db
      .query<
        {
          id: string;
          sector_id: number;
          name: string;
          operator_name: string;
          stop_building_ids: string;
          fleet_size: number;
          vehicle_type_id: string;
          license_fee_monthly_minor: string;
        },
        []
      >("SELECT * FROM bus_routes ORDER BY id")
      .all();
    return rows.map((r) => ({
      id: r.id,
      sectorId: r.sector_id as SectorId,
      name: r.name,
      operatorName: r.operator_name,
      stopBuildingIds: JSON.parse(r.stop_building_ids) as string[],
      fleetSize: r.fleet_size,
      vehicleTypeId: r.vehicle_type_id,
      licenseFeeMonthlyMinor: r.license_fee_monthly_minor,
    }));
  }

  public upsertBusRoute(route: BusRouteDto): void {
    this.db
      .query(`
        INSERT INTO bus_routes (id, sector_id, name, operator_name, stop_building_ids, fleet_size, vehicle_type_id, license_fee_monthly_minor)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          operator_name = excluded.operator_name,
          stop_building_ids = excluded.stop_building_ids,
          fleet_size = excluded.fleet_size,
          vehicle_type_id = excluded.vehicle_type_id,
          license_fee_monthly_minor = excluded.license_fee_monthly_minor
      `)
      .run(
        route.id,
        route.sectorId,
        route.name,
        route.operatorName,
        JSON.stringify(route.stopBuildingIds),
        route.fleetSize,
        route.vehicleTypeId,
        route.licenseFeeMonthlyMinor
      );
  }

  public deleteBusRoute(id: string): void {
    this.db.query("DELETE FROM bus_routes WHERE id = ?1").run(id);
  }

  public loadZones(): ZoneDto[] {
    const rows = this.db
      .query<
        {
          id: string;
          sector_id: number;
          zone_kind: string;
          x: number;
          y: number;
          width: number;
          depth: number;
          occupancy_ratio: number;
        },
        []
      >("SELECT * FROM zones")
      .all();

    return rows.map((r) => ({
      id: r.id,
      sectorId: r.sector_id as SectorId,
      zoneKind: r.zone_kind as ZoneKind,
      x: r.x,
      y: r.y,
      width: r.width,
      depth: r.depth,
      occupancyRatio: r.occupancy_ratio,
    }));
  }

  public upsertZone(z: ZoneDto): void {
    this.db
      .query(`
        INSERT INTO zones (id, sector_id, zone_kind, x, y, width, depth, occupancy_ratio)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET occupancy_ratio = excluded.occupancy_ratio
      `)
      .run(z.id, z.sectorId, z.zoneKind, z.x, z.y, z.width, z.depth, z.occupancyRatio);
  }

  public loadBuildings(): BuildingDto[] {
    const rows = this.db
      .query<
        {
          id: string;
          catalog_id: string;
          sector_id: string;
          tile_x: number;
          tile_y: number;
          width: number;
          depth: number;
          orientation_deg: number;
          level: number;
          construction_progress: number;
          city_equity_share: number;
          stalled_awaiting_private: number;
        },
        []
      >("SELECT * FROM buildings")
      .all();

    return rows.map((r) => ({
      id: r.id,
      catalogId: r.catalog_id,
      sectorId: r.sector_id === "core" ? "core" : (Number(r.sector_id) as SectorId),
      tileX: r.tile_x,
      tileY: r.tile_y,
      width: r.width,
      depth: r.depth,
      orientationDeg: r.orientation_deg as 0 | 45 | 90 | 135,
      level: r.level,
      constructionProgress: r.construction_progress,
      cityEquityShare: r.city_equity_share,
      stalledAwaitingPrivate: r.stalled_awaiting_private === 1,
    }));
  }

  public upsertBuilding(b: BuildingDto): void {
    this.db
      .query(`
        INSERT INTO buildings (
          id, catalog_id, sector_id, tile_x, tile_y, width, depth,
          orientation_deg, level, construction_progress, city_equity_share, stalled_awaiting_private
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(id) DO UPDATE SET
          level = excluded.level,
          construction_progress = excluded.construction_progress,
          city_equity_share = excluded.city_equity_share,
          stalled_awaiting_private = excluded.stalled_awaiting_private
      `)
      .run(
        b.id,
        b.catalogId,
        String(b.sectorId),
        b.tileX,
        b.tileY,
        b.width,
        b.depth,
        b.orientationDeg,
        b.level,
        b.constructionProgress,
        b.cityEquityShare,
        b.stalledAwaitingPrivate ? 1 : 0
      );
  }

  public deleteBuilding(id: string): void {
    this.db.query("DELETE FROM buildings WHERE id = ?1").run(id);
  }

  public loadRecentChat(limit = 60): ChatMessageDto[] {
    const rows = this.db
      .query<
        {
          id: string;
          timestamp_iso: string;
          sender_sector: string;
          sender_name: string;
          channel: string;
          text: string;
        },
        [number]
      >("SELECT * FROM chat_messages ORDER BY rowid DESC LIMIT ?1")
      .all(limit)
      .reverse();

    return rows.map((r) => ({
      id: r.id,
      timestampIso: r.timestamp_iso,
      senderSector:
        r.sender_sector === "system" ? "system" : (Number(r.sender_sector) as SectorId),
      senderName: r.sender_name,
      channel: r.channel as ChatMessageDto["channel"],
      text: r.text,
    }));
  }

  public insertChat(msg: ChatMessageDto): void {
    this.db
      .query(
        "INSERT INTO chat_messages (id, timestamp_iso, sender_sector, sender_name, channel, text) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
      )
      .run(msg.id, msg.timestampIso, String(msg.senderSector), msg.senderName, msg.channel, msg.text);
  }

  public insertLedgerSnapshot(entry: {
    month: number;
    sectorId: SectorId;
    currency: CurrencyCode;
    fxRate: number;
    gdpWcu: number;
    invariantValid: boolean;
    maxErrorMinor: string;
  }): void {
    this.db
      .query(`
        INSERT INTO ledger_snapshots (month, sector_id, currency, fx_rate, gdp_wcu, invariant_valid, max_error_minor, created_at_iso)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      `)
      .run(
        entry.month,
        entry.sectorId,
        entry.currency,
        entry.fxRate,
        entry.gdpWcu,
        entry.invariantValid ? 1 : 0,
        entry.maxErrorMinor,
        new Date().toISOString()
      );
  }

  public countLedgerSnapshots(): number {
    const row = this.db
      .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM ledger_snapshots")
      .get();
    return row?.cnt ?? 0;
  }

  public close(): void {
    this.db.close();
  }
}
