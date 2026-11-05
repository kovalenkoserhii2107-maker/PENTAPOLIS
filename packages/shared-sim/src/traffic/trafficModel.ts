/**
 * Live Traffic Model — Commuters, Freight Hubs, Licensed Buses & Underground Metro (Sprint 5).
 *
 * Deterministic and pure: the same world state always yields the same flows, vehicle IDs and
 * citizens. The server recomputes it on the tactical tick (GDD §1.4, Tier 3) and the client only
 * animates the sampled vehicles between updates.
 *
 * - Real flows (vehicles per game hour) are routed over the road graph and summed per edge. They
 *   drive congestion (BPR) and axle-load wear (`roadPhysics.ts`).
 * - Visible vehicles are a sample of those flows (GDD §7.1): every truck flow, bus and metro train
 *   is shown, commuter cars are thinned to a budget. Each one links to a real citizen dossier.
 * - Bus routes need a Bus Depot (TRN-02) and Bus Stops (TRN-01) on connected streets; buses take
 *   commuters out of cars in the stops' service radius. Metro needs a Metro Depot (TRN-10),
 *   tunnels (TRN-08) and Stations (TRN-09): −50% car trips around stations (GDD §5.4: 40–60%)
 *   and +25% land value.
 */
import type { MasterCatalogs } from "../catalogs/index.ts";
import { computeBuildingAtLevel, type BuildingCatalogEntry } from "../catalogs/buildings.ts";
import type { SectorId } from "../catalogs/visuals.ts";
import type { ExternalGatewayPoint } from "../map/PeninsulaGrid.ts";
import { mulRate, type Money } from "../money/money.ts";
import { commodityUnitTons } from "../construction/developerMarket.ts";
import type {
  BuildingDto,
  BusRouteDto,
  BusRouteStatusDto,
  NetworkSegmentDto,
  SectorTransportStatsDto,
  SegmentTrafficDto,
  TrafficStateDto,
  VehicleAgentDto,
  VehicleRole,
  ZoneDto,
} from "../protocol.ts";
import {
  buildNetworkGraph,
  connectedComponents,
  findRoute,
  locateOnGraph,
  locateRectOnGraph,
  travelTimeCost,
  type EdgeLocation,
  type GraphLink,
  type NetworkGraph,
  type RouteResult,
} from "./roadGraph.ts";
import {
  getRoadClassSpec,
  isRoadKind,
  roadConditionStage,
  roadHealthSpeedFactor,
  roadServiceMonthlyCost,
  roadWearPercentPerHour,
  roadWearPercentPerPass,
  type RoadServiceLevel,
} from "./roadPhysics.ts";

// ---------------------------------------------------------------------------------------------
// Deterministic hashing & randomness
// ---------------------------------------------------------------------------------------------

export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 seeded PRNG in [0, 1). */
export function seededRandom(seedText: string): () => number {
  let a = hashString(seedText);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Constants (design calibration; numeric sources noted)
// ---------------------------------------------------------------------------------------------

/** Share of daily commute trips in each game hour: peaks at 08:00 and 18:00 (GDD §4.3, §1.4). */
const RAW_HOURLY_COMMUTE_PROFILE = [
  0.005, 0.003, 0.002, 0.002, 0.004, 0.015, 0.05, 0.1, 0.115, 0.07, 0.045, 0.04, 0.045, 0.045,
  0.045, 0.05, 0.07, 0.1, 0.11, 0.06, 0.035, 0.02, 0.012, 0.008,
];
const PROFILE_SUM = RAW_HOURLY_COMMUTE_PROFILE.reduce((s, v) => s + v, 0);
export const HOURLY_COMMUTE_PROFILE: readonly number[] = RAW_HOURLY_COMMUTE_PROFILE.map(
  (v) => v / PROFILE_SUM
);

/** Residents per tile by zone density (GDD §2.4). */
const RESIDENTS_PER_TILE: Readonly<Record<string, number>> = {
  "RES-01": 0.55,
  "RES-02": 7,
  "RES-03": 27,
};
/** Jobs per tile in commercial / office zones (GDD §2.4). */
const JOBS_PER_TILE: Readonly<Record<string, number>> = {
  "COM-01": 1,
  "COM-02": 3,
  "COM-03": 10,
  "OFF-01": 6,
  "OFF-02": 20,
};
/** Car ownership by residential density: cottages drive, tower blocks ride. */
const CAR_OWNERSHIP: Readonly<Record<string, number>> = {
  "RES-01": 0.9,
  "RES-02": 0.65,
  "RES-03": 0.5,
};
const PERSONS_PER_HOUSEHOLD = 2.2;
const EMPLOYED_PER_HOUSEHOLD = 1.25;
const BUS_MODE_SHIFT = 0.25;
const METRO_MODE_SHIFT = 0.5;
const FREE_TRANSIT_CAR_MULTIPLIER = 0.7;
export const METRO_LAND_VALUE_BOOST = 0.25;
const BUS_DWELL_HOURS_PER_STOP = 0.03;
const BUS_LAYOVER_HOURS = 0.15;
const BUS_MAX_DEPARTURES_PER_HOUR = 12;
/** Licensed bus operators pay the treasury per bus per game month (WCU units). */
export const BUS_LICENSE_FEE_PER_BUS_PER_MONTH_UNITS = 450;
/** Visual time dilation: 50 km/h ≈ 3 tiles per real second on screen. */
export const VISUAL_TILES_PER_SEC_PER_KMH = 0.06;
const STOP_SNAP_TILES = 4;
const ZONE_SNAP_TILES = 8;
const BUILDING_SNAP_TILES = 10;
const GATEWAY_SNAP_TILES = 14;
const EMPTY_RETURN_WEAR_SHARE = 0.12;
const PCE: Readonly<Record<VehicleRole, number>> = { commuter: 1, freight: 2.5, bus: 2, metro: 0, service: 1.5 };

const SERVICE_COLORS: Readonly<Record<string, number>> = {
  "MUN-01": 0x1d4ed8,
  "MUN-02": 0x1d4ed8,
  "MUN-03": 0xf8fafc,
  "MUN-04": 0xdc2626,
};

/** Crew role of each municipal responder vehicle (Sprint 6 dispatch). */
const RESPONDER_ROLE_RU: Readonly<Record<string, string>> = {
  "MUN-01": "Полицейский патрульный",
  "MUN-02": "Полицейский (ОМОН)",
  "MUN-03": "Фельдшер скорой помощи",
  "MUN-04": "Пожарный",
  "MUN-06": "Водитель мусоровоза",
  "MUN-09": "Аварийный монтёр",
};

function truckForCommodity(commodity: string): string {
  if (/ore|coal|limestone|grain|quartz/i.test(commodity)) return "TRK-04";
  if (/timber/i.test(commodity)) return "TRK-09";
  if (/crude|fuel/i.test(commodity)) return "TRK-03";
  if (/cement/i.test(commodity)) return "TRK-08";
  if (/car$/i.test(commodity)) return "TRK-07";
  if (/flour|food/i.test(commodity)) return "TRK-06";
  return "TRK-02";
}

const CAR_COLORS = [0x38bdf8, 0xf8fafc, 0xfacc15, 0x22c55e, 0xf97316, 0xa78bfa, 0x94a3b8, 0xef4444];
const TRUCK_COLORS = [0xf59e0b, 0xd97706, 0xb45309, 0x78716c];
const BUS_COLORS = [0xdc2626, 0x2563eb, 0x16a34a, 0x9333ea, 0xea580c];

const KIND_NAMES_RU: Readonly<Record<string, string>> = {
  street_2lane: "улица (2 полосы)",
  avenue_4lane: "проспект (4 полосы)",
  express_6lane: "магистраль (6 полос)",
  heavy_bypass: "промышленная трасса",
  metro_tunnel: "тоннель метро",
  rail: "Ж/Д",
};

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export interface TrafficSectorContext {
  readonly sectorId: SectorId;
  readonly activeDecreeIds: readonly string[];
  readonly roadServiceLevel: RoadServiceLevel;
  readonly fxRatePerWcu: number;
}

export interface TrafficModelInput {
  readonly catalogs: MasterCatalogs;
  readonly segments: readonly NetworkSegmentDto[];
  readonly buildings: readonly BuildingDto[];
  readonly zones: readonly ZoneDto[];
  readonly busRoutes: readonly BusRouteDto[];
  readonly gateways: readonly ExternalGatewayPoint[];
  readonly sectors: readonly TrafficSectorContext[];
  readonly gameHourOfDay: number;
  readonly version: number;
  readonly visibleCarBudget?: number;
  /** Responder crews driving to emergencies (Sprint 6). */
  readonly dispatches?: readonly ServiceDispatchInput[];
  /** Road joints through border posts (Sprint 7). */
  readonly links?: readonly GraphLink[];
  /** Customs terms for cargo crossing a border post (Sprint 7); `null` when the post is unknown. */
  readonly crossing?: (postId: string, from: SectorId, to: SectorId, commodity: string) => CrossingTerms | null;
  /** Output multiplier of gasified plants (Sprint 7 gas network). */
  readonly plantOutputMultiplier?: ReadonlyMap<string, number>;
}

export interface CrossingTerms {
  readonly allowed: boolean;
  readonly importDuty: number;
  readonly exportDuty: number;
  readonly smuggling: number;
}

/** Freight that crosses a border post: the customs base of both sides (Sprint 7). */
export interface CrossBorderFlow {
  readonly postId: string;
  readonly fromSector: SectorId;
  readonly toSector: SectorId;
  readonly commodity: string;
  readonly trucksPerHour: number;
  /** World reference value of the cargo per game hour (WCU minor units). */
  readonly valueWcuPerHour: Money;
  readonly terms: CrossingTerms;
}

export interface ServiceDispatchInput {
  readonly emergencyInstanceId: string;
  readonly emergencyTitleRu: string;
  readonly sectorId: SectorId;
  readonly vehicleTypeId: string;
  readonly buildingId: string;
  readonly tileX: number;
  readonly tileY: number;
}

export interface VehicleCargoRecord {
  readonly commodity: string;
  readonly payload: number;
  readonly capacity: number;
  readonly unit: string;
  /** World reference price of the payload in WCU minor units. */
  readonly valueWcu: Money;
  readonly exportViaGateway: boolean;
  /** Customs at a border post on the way to a neighbour's plant (Sprint 7). */
  readonly border?: { readonly postId: string; readonly toSector: SectorId; readonly importDuty: number };
}

export interface VehicleAgentRecord {
  readonly dto: VehicleAgentDto;
  readonly ownerLabel: string;
  readonly originLabel: string;
  readonly waypointLabel: string;
  readonly destinationLabel: string;
  readonly cargo: VehicleCargoRecord | null;
  readonly passengers: { readonly onboard: number; readonly capacity: number } | null;
  readonly speedKmh: number;
  readonly speedLimitKmh: number;
  readonly avgRoadHealth: number;
  readonly roadWearFactor: number;
  readonly roadWearPerPassPercent: number;
  readonly driverCitizenId: string;
  readonly shiftHoursRemaining: number;
}

export type CitizenCommuteMode = "car" | "bus" | "metro" | "driver";

export interface CitizenContext {
  readonly citizenId: string;
  readonly sectorId: SectorId;
  readonly classId: "workers" | "engineers" | "elite" | "retirees";
  readonly homeLabel: string;
  /** Zone the citizen lives in, when they live in a zoned district. */
  readonly homeZoneId: string | null;
  readonly homeX: number;
  readonly homeY: number;
  readonly workLabel: string;
  readonly workRoleRu: string;
  readonly workX: number;
  readonly workY: number;
  readonly commuteTiles: number;
  readonly commuteMode: CitizenCommuteMode;
  readonly commuteMinHealth: number;
  readonly busCovered: boolean;
  readonly metroCovered: boolean;
  readonly vehicleId: string | null;
}

export interface TrafficComputation {
  readonly state: TrafficStateDto;
  readonly vehicles: ReadonlyMap<string, VehicleAgentRecord>;
  readonly citizens: ReadonlyMap<string, CitizenContext>;
  /** Health % lost per game hour, per road segment id. */
  readonly segmentWearPerHour: ReadonlyMap<string, number>;
  /** Zones inside a working metro station's / licensed bus stop's service radius. */
  readonly metroZoneIds: ReadonlySet<string>;
  readonly busZoneIds: ReadonlySet<string>;
  readonly crossBorderFlows: readonly CrossBorderFlow[];
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface Place {
  readonly key: string;
  readonly label: string;
  readonly sectorId: SectorId | "core";
  readonly x: number;
  readonly y: number;
  readonly loc: EdgeLocation | null;
}

const isOperational = (b: BuildingDto) => b.constructionProgress >= 1 && !b.stalledAwaitingPrivate;

function buildingCenter(b: BuildingDto): [number, number] {
  return [b.tileX + b.width / 2, b.tileY + b.depth / 2];
}

function zoneCenter(z: ZoneDto): [number, number] {
  return [z.x + z.width / 2, z.y + z.depth / 2];
}

const unitTons = commodityUnitTons;

function vehicleIdFor(seed: string): string {
  return `VH-${(hashString(`veh:${seed}`) % 900_000) + 100_000}`;
}

function citizenIdFor(seed: string): string {
  return `CZ-${(hashString(`cz:${seed}`) % 9_000_000) + 1_000_000}`;
}

function routeKey(a: Place, b: Place): string {
  return `${a.key}->${b.key}`;
}

function mainCorridorLabel(graph: NetworkGraph, route: RouteResult): string {
  const byKind = new Map<string, number>();
  for (const es of route.edgeShares) {
    const e = graph.edges[es.edgeId]!;
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + e.lengthTiles * es.share);
  }
  let best = "";
  let bestLen = -1;
  for (const [k, len] of byKind) {
    if (len > bestLen) {
      best = k;
      bestLen = len;
    }
  }
  return `по: ${KIND_NAMES_RU[best] ?? best} · ${(route.lengthTiles * 0.01).toFixed(1)} км`;
}

function routeHealthStats(graph: NetworkGraph, route: RouteResult): { avg: number; min: number; limit: number } {
  let len = 0;
  let healthSum = 0;
  let limitSum = 0;
  let min = 100;
  for (const es of route.edgeShares) {
    const e = graph.edges[es.edgeId]!;
    const l = e.lengthTiles * es.share;
    len += l;
    healthSum += e.healthPercent * l;
    limitSum += e.speedLimitKmh * l;
    if (es.share > 0) min = Math.min(min, e.healthPercent);
  }
  return {
    avg: len > 0 ? healthSum / len : 100,
    min,
    limit: len > 0 ? limitSum / len : 50,
  };
}

function routeWearPerPass(graph: NetworkGraph, route: RouteResult, wearFactor: number): number {
  let len = 0;
  let sum = 0;
  for (const es of route.edgeShares) {
    const e = graph.edges[es.edgeId]!;
    if (!isRoadKind(e.kind)) continue;
    const l = e.lengthTiles * es.share;
    len += l;
    sum += roadWearPercentPerPass(e.kind, wearFactor) * l;
  }
  return len > 0 ? sum / len : 0;
}

// ---------------------------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------------------------

export function computeTraffic(input: TrafficModelInput): TrafficComputation {
  const { catalogs } = input;
  const hour = ((Math.floor(input.gameHourOfDay) % 24) + 24) % 24;
  const hourShare = HOURLY_COMMUTE_PROFILE[hour]!;
  const sectorCtx = new Map(input.sectors.map((s) => [s.sectorId, s]));
  const roadGraph = buildNetworkGraph(input.segments, "road", input.links ?? []);
  const metroGraph = buildNetworkGraph(input.segments, "metro");
  const roadCost = travelTimeCost();

  const edgeVehicles = new Float64Array(roadGraph.edges.length);
  const edgeHeavy = new Float64Array(roadGraph.edges.length);
  const edgeEsal = new Float64Array(roadGraph.edges.length);
  const edgePce = new Float64Array(roadGraph.edges.length);

  const addFlow = (route: RouteResult, perHour: number, wearFactor: number, role: VehicleRole) => {
    for (const es of route.edgeShares) {
      if (es.share <= 0) continue;
      edgeVehicles[es.edgeId]! += perHour;
      edgePce[es.edgeId]! += perHour * PCE[role];
      edgeEsal[es.edgeId]! += perHour * wearFactor;
      if (role !== "commuter") edgeHeavy[es.edgeId]! += perHour;
    }
  };

  const routeCache = new Map<string, RouteResult | null>();
  const routeBetween = (graph: NetworkGraph, from: Place, to: Place): RouteResult | null => {
    if (!from.loc || !to.loc) return null;
    const key = `${graph.layer}:${routeKey(from, to)}`;
    if (!routeCache.has(key)) {
      routeCache.set(key, findRoute(graph, from.loc, to.loc, graph.layer === "road" ? roadCost : undefined));
    }
    return routeCache.get(key)!;
  };

  const vehicles = new Map<string, VehicleAgentRecord>();
  const citizens = new Map<string, CitizenContext>();

  const operational = input.buildings.filter(isOperational);
  const buildingPlace = (b: BuildingDto, graph: NetworkGraph, snap: number): Place => {
    const entry = catalogs.buildingsById.get(b.catalogId);
    const [x, y] = buildingCenter(b);
    return {
      key: `b:${b.id}`,
      label: `${entry?.nameRu ?? b.catalogId} #${b.id}`,
      sectorId: b.sectorId,
      x,
      y,
      loc: locateRectOnGraph(graph, { x: b.tileX, y: b.tileY, width: b.width, depth: b.depth }, snap),
    };
  };

  // -----------------------------------------------------------------------------------------
  // 1. Public transport supply: bus routes & metro lines
  // -----------------------------------------------------------------------------------------
  const busStatuses: BusRouteStatusDto[] = [];
  const operatingStops: Array<{ sectorId: SectorId; x: number; y: number; radius: number }> = [];
  const busTrips: Array<{ route: BusRouteDto; path: RouteResult; legs: RouteResult[]; perHour: number }> = [];
  const buildingById = new Map(input.buildings.map((b) => [b.id, b]));

  for (const route of input.busRoutes) {
    const fail = (statusRu: string) =>
      busStatuses.push({ routeId: route.id, operating: false, statusRu, lengthTiles: 0, busesPerHour: 0, path: [] });

    const hasDepot = operational.some((b) => b.catalogId === "TRN-02" && b.sectorId === route.sectorId);
    if (!hasDepot) {
      fail("Нет действующего автобусного парка (TRN-02) в секторе");
      continue;
    }
    const stops = route.stopBuildingIds.map((id) => buildingById.get(id));
    if (stops.length < 2 || stops.some((s) => !s || s.catalogId !== "TRN-01" || s.sectorId !== route.sectorId)) {
      fail("Маршрут должен включать ≥2 остановки TRN-01 своего сектора");
      continue;
    }
    if (stops.some((s) => !isOperational(s!))) {
      fail("Остановки ещё строятся");
      continue;
    }
    const places = stops.map((s) => buildingPlace(s!, roadGraph, STOP_SNAP_TILES));
    const unsnapped = places.findIndex((p) => !p.loc);
    if (unsnapped >= 0) {
      fail(`Остановка #${stops[unsnapped]!.id} не стоит у дороги`);
      continue;
    }
    const legs: RouteResult[] = [];
    let broken = -1;
    for (let i = 0; i + 1 < places.length; i++) {
      const leg = routeBetween(roadGraph, places[i]!, places[i + 1]!);
      if (!leg) {
        broken = i;
        break;
      }
      legs.push(leg);
    }
    if (broken >= 0) {
      fail(`Нет дороги между остановками ${broken + 1} и ${broken + 2}`);
      continue;
    }
    const points: number[] = [];
    let lengthTiles = 0;
    let hours = 0;
    const edgeShares: Array<{ edgeId: number; share: number }> = [];
    for (const leg of legs) {
      const start = points.length === 0 ? 0 : 2;
      for (let i = start; i < leg.points.length; i++) points.push(leg.points[i]!);
      lengthTiles += leg.lengthTiles;
      hours += leg.travelTimeHours;
      edgeShares.push(...leg.edgeShares);
    }
    const path: RouteResult = { points, lengthTiles, travelTimeHours: hours, edgeShares };
    // Round trip: both directions, ~2 min dwell per stop, 9 min layover at each terminus
    const roundTripHours = hours * 2 + BUS_DWELL_HOURS_PER_STOP * places.length * 2 + BUS_LAYOVER_HOURS * 2;
    const perHour = Math.min(BUS_MAX_DEPARTURES_PER_HOUR, route.fleetSize / roundTripHours);
    busTrips.push({ route, path, legs, perHour });
    busStatuses.push({
      routeId: route.id,
      operating: true,
      statusRu: `Работает: ${route.fleetSize} авт., интервал ${Math.max(1, Math.round(60 / Math.max(perHour, 0.01)))} мин`,
      lengthTiles: Number(lengthTiles.toFixed(1)),
      busesPerHour: Number((perHour * 2).toFixed(2)),
      path: points,
    });
    for (const s of stops) {
      const entry = catalogs.buildingsById.get(s!.catalogId);
      const [x, y] = buildingCenter(s!);
      operatingStops.push({ sectorId: route.sectorId, x, y, radius: entry?.serviceRadiusTiles || 40 });
    }
  }

  // Metro: stations on tunnels, depot in sector
  const metroLabels = connectedComponents(metroGraph);
  const metroStationsBySector = new Map<SectorId, number>();
  const metroOperationalBySector = new Map<SectorId, boolean>();
  const operatingStations: Array<{ sectorId: SectorId; x: number; y: number; radius: number }> = [];
  const metroLines: Array<{ sectorId: SectorId; stations: Place[]; legs: RouteResult[] }> = [];
  {
    const stationsBySectorComp = new Map<string, Place[]>();
    for (const b of operational) {
      if (b.catalogId !== "TRN-09" || b.sectorId === "core") continue;
      const sectorId = b.sectorId;
      metroStationsBySector.set(sectorId, (metroStationsBySector.get(sectorId) ?? 0) + 1);
      const hasDepot = operational.some((d) => d.catalogId === "TRN-10" && d.sectorId === sectorId);
      const place = buildingPlace(b, metroGraph, STOP_SNAP_TILES);
      if (!hasDepot || !place.loc) continue;
      const comp = metroLabels[metroGraph.edges[place.loc.edgeId]!.a]!;
      const key = `${sectorId}:${comp}`;
      const list = stationsBySectorComp.get(key) ?? [];
      list.push(place);
      stationsBySectorComp.set(key, list);
    }
    for (const [key, stations] of [...stationsBySectorComp].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (stations.length < 2) continue;
      const sectorId = Number(key.split(":")[0]) as SectorId;
      // Greedy chain from the station farthest from the centroid (terminus) to its nearest neighbours
      const cx = stations.reduce((s, p) => s + p.x, 0) / stations.length;
      const cy = stations.reduce((s, p) => s + p.y, 0) / stations.length;
      const remaining = stations.slice().sort((p, q) => Math.hypot(q.x - cx, q.y - cy) - Math.hypot(p.x - cx, p.y - cy));
      const ordered = [remaining.shift()!];
      while (remaining.length > 0) {
        const last = ordered[ordered.length - 1]!;
        remaining.sort((p, q) => Math.hypot(p.x - last.x, p.y - last.y) - Math.hypot(q.x - last.x, q.y - last.y));
        ordered.push(remaining.shift()!);
      }
      const legs: RouteResult[] = [];
      for (let i = 0; i + 1 < ordered.length; i++) {
        const leg = routeBetween(metroGraph, ordered[i]!, ordered[i + 1]!);
        if (leg) legs.push(leg);
      }
      if (legs.length === 0) continue;
      metroLines.push({ sectorId, stations: ordered, legs });
      metroOperationalBySector.set(sectorId, true);
      for (const st of ordered) {
        operatingStations.push({
          sectorId,
          x: st.x,
          y: st.y,
          radius: catalogs.buildingsById.get("TRN-09")?.serviceRadiusTiles || 60,
        });
      }
    }
  }

  const coveredBy = (
    list: ReadonlyArray<{ sectorId: SectorId; x: number; y: number; radius: number }>,
    sectorId: SectorId,
    x: number,
    y: number
  ) => list.some((s) => s.sectorId === sectorId && Math.hypot(s.x - x, s.y - y) <= s.radius);

  // -----------------------------------------------------------------------------------------
  // 2. Job sites per sector
  // -----------------------------------------------------------------------------------------
  interface JobSite {
    readonly place: Place;
    readonly jobs: number;
    readonly roleRu: string;
    readonly classHint: "workers" | "engineers";
  }
  const jobSitesBySector = new Map<SectorId, JobSite[]>();
  const pushJob = (sectorId: SectorId, site: JobSite) => {
    const list = jobSitesBySector.get(sectorId) ?? [];
    list.push(site);
    jobSitesBySector.set(sectorId, list);
  };
  for (const z of input.zones) {
    const perTile = JOBS_PER_TILE[z.zoneKind];
    if (!perTile) continue;
    const [x, y] = zoneCenter(z);
    pushJob(z.sectorId, {
      place: {
        key: `z:${z.id}`,
        label: `${z.zoneKind.startsWith("OFF") ? "Деловой квартал" : "Торговый квартал"} ${z.zoneKind} #${z.id}`,
        sectorId: z.sectorId,
        x,
        y,
        loc: locateRectOnGraph(roadGraph, { x: z.x, y: z.y, width: z.width, depth: z.depth }, ZONE_SNAP_TILES),
      },
      jobs: z.width * z.depth * perTile * z.occupancyRatio,
      roleRu: z.zoneKind.startsWith("OFF") ? "Офисный сотрудник" : "Продавец-консультант",
      classHint: z.zoneKind.startsWith("OFF") ? "engineers" : "workers",
    });
  }
  for (const b of operational) {
    if (b.sectorId === "core" || b.catalogId === "TRN-01") continue;
    const entry = catalogs.buildingsById.get(b.catalogId);
    if (!entry) continue;
    const stats = computeBuildingAtLevel(entry, catalogs.levelCurves, b.level);
    const jobs = stats.workers + stats.engineers;
    if (jobs <= 0) continue;
    pushJob(b.sectorId, {
      place: buildingPlace(b, roadGraph, BUILDING_SNAP_TILES),
      jobs,
      roleRu: stats.engineers > stats.workers ? "Инженер" : "Оператор производства",
      classHint: stats.engineers > stats.workers ? "engineers" : "workers",
    });
  }

  // -----------------------------------------------------------------------------------------
  // 3. Commuter flows (home -> work), routed and sampled
  // -----------------------------------------------------------------------------------------
  interface CommuteFlow {
    readonly sectorId: SectorId;
    readonly home: Place;
    readonly homeZone: ZoneDto;
    readonly job: JobSite;
    readonly route: RouteResult;
    readonly carsPerHour: number;
    readonly busCovered: boolean;
    readonly metroCovered: boolean;
  }
  const commuteFlows: CommuteFlow[] = [];
  const sectorHouseholds = new Map<SectorId, number>();
  const sectorBusCoveredHh = new Map<SectorId, number>();
  const sectorMetroCoveredHh = new Map<SectorId, number>();
  const sectorResTiles = new Map<SectorId, number>();
  const sectorMetroResTiles = new Map<SectorId, number>();
  const sectorCarTrips = new Map<SectorId, number>();
  const sectorTransitRiders = new Map<SectorId, number>();
  const sectorTruckTrips = new Map<SectorId, number>();
  const add = (m: Map<SectorId, number>, k: SectorId, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  for (const z of input.zones) {
    const density = RESIDENTS_PER_TILE[z.zoneKind];
    if (density === undefined) continue;
    const sectorId = z.sectorId;
    const tiles = z.width * z.depth;
    const households = (tiles * density * z.occupancyRatio) / PERSONS_PER_HOUSEHOLD;
    const [hx, hy] = zoneCenter(z);
    const busCovered = coveredBy(operatingStops, sectorId, hx, hy);
    const metroCovered = coveredBy(operatingStations, sectorId, hx, hy);
    add(sectorHouseholds, sectorId, households);
    add(sectorResTiles, sectorId, tiles);
    if (busCovered) add(sectorBusCoveredHh, sectorId, households);
    if (metroCovered) {
      add(sectorMetroCoveredHh, sectorId, households);
      add(sectorMetroResTiles, sectorId, tiles);
    }

    const freeTransit = sectorCtx.get(sectorId)?.activeDecreeIds.includes("FREE_TRANSIT") ?? false;
    const transitAvailable = busCovered || metroCovered;
    let carShare = CAR_OWNERSHIP[z.zoneKind] ?? 0.6;
    if (busCovered) carShare *= 1 - BUS_MODE_SHIFT;
    if (metroCovered) carShare *= 1 - METRO_MODE_SHIFT;
    if (freeTransit && transitAvailable) carShare *= FREE_TRANSIT_CAR_MULTIPLIER;

    const commutersPerHour = households * EMPLOYED_PER_HOUSEHOLD * 2 * hourShare;
    if (transitAvailable) {
      add(sectorTransitRiders, sectorId, commutersPerHour * (1 - carShare / (CAR_OWNERSHIP[z.zoneKind] ?? 0.6)));
    }

    const home: Place = {
      key: `z:${z.id}`,
      label: `Жилой квартал ${z.zoneKind} #${z.id}`,
      sectorId,
      x: hx,
      y: hy,
      loc: locateRectOnGraph(roadGraph, { x: z.x, y: z.y, width: z.width, depth: z.depth }, ZONE_SNAP_TILES),
    };
    if (!home.loc) continue;
    const jobs = (jobSitesBySector.get(sectorId) ?? [])
      .filter((j) => j.place.loc && j.jobs > 0)
      .map((j) => ({ j, w: j.jobs / (Math.hypot(j.place.x - hx, j.place.y - hy) + 20) ** 2 }))
      .sort((p, q) => q.w - p.w || (p.j.place.key < q.j.place.key ? -1 : 1))
      .slice(0, 3);
    const wSum = jobs.reduce((s, p) => s + p.w, 0);
    for (const { j, w } of jobs) {
      const route = routeBetween(roadGraph, home, j.place);
      if (!route) continue;
      const carsPerHour = commutersPerHour * carShare * (w / wSum);
      if (carsPerHour <= 0) continue;
      addFlow(route, carsPerHour, 1, "commuter");
      add(sectorCarTrips, sectorId, carsPerHour);
      commuteFlows.push({ sectorId, home, homeZone: z, job: j, route, carsPerHour, busCovered, metroCovered });
    }
  }

  // -----------------------------------------------------------------------------------------
  // 4. Freight: extraction & factories ship by truck to their consumers or the gateway
  // -----------------------------------------------------------------------------------------
  interface FreightFlow {
    readonly sectorId: SectorId;
    readonly origin: Place;
    readonly originEntry: BuildingCatalogEntry;
    readonly originBuilding: BuildingDto;
    readonly dest: Place;
    readonly exportViaGateway: boolean;
    readonly route: RouteResult;
    readonly truckTypeId: string;
    readonly trucksPerHour: number;
    readonly commodity: string;
    readonly unit: string;
    readonly border: CrossBorderFlow | null;
  }
  const freightFlows: FreightFlow[] = [];
  const crossBorderFlows: CrossBorderFlow[] = [];
  const postsOnRoute = (route: RouteResult): string[] => {
    const ids: string[] = [];
    for (const es of route.edgeShares) {
      const linkId = roadGraph.edges[es.edgeId]!.linkId;
      if (linkId && !ids.includes(linkId)) ids.push(linkId);
    }
    return ids;
  };
  const gatewayPlaces = input.gateways.map<Place>((g) => ({
    key: `g:${g.id}`,
    label: g.labelRu,
    sectorId: g.sectorId,
    x: g.tileX,
    y: g.tileY,
    loc: locateOnGraph(roadGraph, g.tileX, g.tileY, GATEWAY_SNAP_TILES),
  }));

  for (const b of operational) {
    if (b.sectorId === "core") continue;
    const entry = catalogs.buildingsById.get(b.catalogId);
    if (!entry || !["EXT", "PRO", "CMP", "ASM"].includes(entry.prefix)) continue;
    if (/m3/i.test(entry.capacityUnit)) continue; // natural gas leaves by pipeline
    const stats = computeBuildingAtLevel(entry, catalogs.levelCurves, b.level);
    const tonsPerHour =
      stats.capacity * unitTons(entry.capacityUnit) * (input.plantOutputMultiplier?.get(b.id) ?? 1);
    if (tonsPerHour <= 0) continue;
    const truckTypeId = truckForCommodity(entry.mainOutput);
    const truck = catalogs.vehiclesById.get(truckTypeId);
    if (!truck) continue;

    const origin = buildingPlace(b, roadGraph, BUILDING_SNAP_TILES);
    if (!origin.loc) continue;
    const feeds = new Set(catalogs.buildingLinks.get(entry.id)?.feedsBuildingIds ?? []);
    const consumers = operational
      .filter((c) => c.sectorId === b.sectorId && c.id !== b.id && feeds.has(c.catalogId))
      .map((c) => buildingPlace(c, roadGraph, BUILDING_SNAP_TILES))
      .filter((p) => p.loc)
      .sort((p, q) => Math.hypot(p.x - origin.x, p.y - origin.y) - Math.hypot(q.x - origin.x, q.y - origin.y));

    let dest: Place | null = null;
    let route: RouteResult | null = null;
    let exportViaGateway = false;
    let border: { postId: string; toSector: SectorId; terms: CrossingTerms } | null = null;
    for (const c of consumers) {
      route = routeBetween(roadGraph, origin, c);
      if (route) {
        dest = c;
        break;
      }
    }
    // Priority 2 (GDD §4.4): a neighbour's consumer plant through an open border post
    if (!route && input.crossing) {
      const foreign = operational
        .filter((c) => c.sectorId !== b.sectorId && c.sectorId !== "core" && feeds.has(c.catalogId))
        .map((c) => ({ c, place: buildingPlace(c, roadGraph, BUILDING_SNAP_TILES) }))
        .filter((p) => p.place.loc)
        .sort((p, q) => Math.hypot(p.place.x - origin.x, p.place.y - origin.y) - Math.hypot(q.place.x - origin.x, q.place.y - origin.y));
      for (const { c, place } of foreign) {
        const r = routeBetween(roadGraph, origin, place);
        if (!r) continue;
        const posts = postsOnRoute(r);
        const fromSector = b.sectorId;
        const terms = posts.map((pid) => input.crossing!(pid, fromSector, c.sectorId as SectorId, entry.mainOutput));
        if (posts.length === 0 || terms.some((t) => !t || !t.allowed)) continue;
        route = r;
        dest = place;
        border = { postId: posts[0]!, toSector: c.sectorId as SectorId, terms: terms[0]! };
        break;
      }
    }
    if (!route) {
      for (const g of gatewayPlaces.filter((p) => p.sectorId === b.sectorId)) {
        route = routeBetween(roadGraph, origin, g);
        if (route) {
          dest = g;
          exportViaGateway = true;
          break;
        }
      }
    }
    if (!route || !dest) continue;

    const trucksPerHour = tonsPerHour / Math.max(1, truck.capacity * unitTons(truck.capacityUnit));
    let borderFlow: CrossBorderFlow | null = null;
    if (border) {
      const recipe = catalogs.commoditiesByName.get(entry.mainOutput);
      const unitsPerHour = tonsPerHour / unitTons(entry.capacityUnit);
      borderFlow = {
        postId: border.postId,
        fromSector: b.sectorId,
        toSector: border.toSector,
        commodity: entry.mainOutput,
        trucksPerHour,
        valueWcuPerHour: recipe ? mulRate(recipe.worldReferencePrice, unitsPerHour) : 0n,
        terms: border.terms,
      };
      crossBorderFlows.push(borderFlow);
    }
    addFlow(route, trucksPerHour, truck.roadWearFactor, "freight");
    addFlow(route, trucksPerHour, truck.roadWearFactor * EMPTY_RETURN_WEAR_SHARE, "freight");
    add(sectorTruckTrips, b.sectorId, trucksPerHour * 2);
    freightFlows.push({
      sectorId: b.sectorId,
      origin,
      originEntry: entry,
      originBuilding: b,
      dest,
      exportViaGateway,
      route,
      truckTypeId,
      trucksPerHour,
      commodity: entry.mainOutput,
      unit: entry.capacityUnit.replace(/ per game hour/i, ""),
      border: borderFlow,
    });
  }

  // Bus flows wear the streets too (PT-02: 1,500 ESAL)
  const busType = catalogs.vehiclesById.get("PT-02");
  for (const trip of busTrips) {
    addFlow(trip.path, trip.perHour * 2, busType?.roadWearFactor ?? 1500, "bus");
  }

  // -----------------------------------------------------------------------------------------
  // 5. Per-segment loads, congestion and wear
  // -----------------------------------------------------------------------------------------
  const segAgg = new Map<string, { len: number; veh: number; heavy: number; esal: number; pce: number }>();
  roadGraph.edges.forEach((e, i) => {
    const agg = segAgg.get(e.segmentId) ?? { len: 0, veh: 0, heavy: 0, esal: 0, pce: 0 };
    agg.len += e.lengthTiles;
    agg.veh += edgeVehicles[i]! * e.lengthTiles;
    agg.heavy += edgeHeavy[i]! * e.lengthTiles;
    agg.esal += edgeEsal[i]! * e.lengthTiles;
    agg.pce += edgePce[i]! * e.lengthTiles;
    segAgg.set(e.segmentId, agg);
  });

  const segmentTraffic: SegmentTrafficDto[] = [];
  const segmentWearPerHour = new Map<string, number>();
  for (const seg of input.segments) {
    if (!isRoadKind(seg.kind)) continue;
    const agg = segAgg.get(seg.id);
    const len = agg?.len || 1;
    const veh = (agg?.veh ?? 0) / len;
    const heavy = (agg?.heavy ?? 0) / len;
    const esal = (agg?.esal ?? 0) / len;
    const pce = (agg?.pce ?? 0) / len;
    const spec = getRoadClassSpec(seg.kind);
    const vc = pce / spec.capacityVehiclesPerHour;
    const truckWeightControl =
      sectorCtx.get(seg.sectorId)?.activeDecreeIds.includes("TRUCK_WEIGHT_CONTROL") ?? false;
    const wear = roadWearPercentPerHour({ kind: seg.kind, esalPerHour: esal, truckWeightControl });
    segmentWearPerHour.set(seg.id, wear);
    segmentTraffic.push({
      segmentId: seg.id,
      vehiclesPerHour: Number(veh.toFixed(2)),
      heavyVehiclesPerHour: Number(heavy.toFixed(2)),
      esalPerHour: Math.round(esal),
      volumeCapacityRatio: Number(vc.toFixed(3)),
      speedFactor: Number(roadHealthSpeedFactor(seg.healthPercent).toFixed(3)),
      wearPercentPerHour: Number(wear.toFixed(5)),
      stage: roadConditionStage(seg.healthPercent),
    });
  }

  // -----------------------------------------------------------------------------------------
  // 6. Visible vehicles (sampled) with inspector & citizen context
  // -----------------------------------------------------------------------------------------
  const visibleCarBudget = input.visibleCarBudget ?? 420;
  const totalCars = commuteFlows.reduce((s, f) => s + f.carsPerHour, 0);
  const carRatio = totalCars > 0 ? Math.min(0.5, visibleCarBudget / totalCars) : 0;

  const emitVehicle = (params: {
    seed: string;
    role: VehicleRole;
    vehicleTypeId: string;
    sectorId: SectorId;
    layer: "surface" | "underground";
    graph: NetworkGraph;
    route: RouteResult;
    colorHex: number;
    ownerLabel: string;
    originLabel: string;
    destinationLabel: string;
    cargo: VehicleCargoRecord | null;
    passengers: { onboard: number; capacity: number } | null;
    citizen: Omit<CitizenContext, "citizenId" | "vehicleId">;
    rnd: () => number;
  }) => {
    const id = vehicleIdFor(params.seed);
    if (vehicles.has(id)) return;
    const vt = catalogs.vehiclesById.get(params.vehicleTypeId);
    const health = routeHealthStats(params.graph, params.route);
    const pathKmh = params.route.travelTimeHours > 0 ? (params.route.lengthTiles * 0.01) / params.route.travelTimeHours : health.limit;
    const speedKmh = Math.max(5, Math.min(vt?.speedKmh || pathKmh, pathKmh));
    const wearFactor = params.layer === "underground" ? 0 : vt?.roadWearFactor ?? 1;
    const citizenId = citizenIdFor(params.seed);
    const dto: VehicleAgentDto = {
      id,
      vehicleTypeId: params.vehicleTypeId,
      role: params.role,
      sectorId: params.sectorId,
      layer: params.layer,
      path: params.route.points.map((v) => Number(v.toFixed(2))),
      pathLengthTiles: Number(params.route.lengthTiles.toFixed(2)),
      speedTilesPerSec: Number((speedKmh * VISUAL_TILES_PER_SEC_PER_KMH).toFixed(3)),
      phase: Number(params.rnd().toFixed(4)),
      colorHex: params.colorHex,
    };
    vehicles.set(id, {
      dto,
      ownerLabel: params.ownerLabel,
      originLabel: params.originLabel,
      waypointLabel: mainCorridorLabel(params.graph, params.route),
      destinationLabel: params.destinationLabel,
      cargo: params.cargo,
      passengers: params.passengers,
      speedKmh: Number(speedKmh.toFixed(1)),
      speedLimitKmh: Math.round(health.limit),
      avgRoadHealth: Number(health.avg.toFixed(1)),
      roadWearFactor: wearFactor,
      roadWearPerPassPercent:
        params.layer === "underground" ? 0 : Number(routeWearPerPass(params.graph, params.route, wearFactor).toPrecision(3)),
      driverCitizenId: citizenId,
      shiftHoursRemaining: Number((0.5 + params.rnd() * 7).toFixed(1)),
    });
    citizens.set(citizenId, { ...params.citizen, citizenId, vehicleId: id });
  };

  // Commuter cars
  let carCarry = 0;
  for (const f of commuteFlows) {
    carCarry += f.carsPerHour * carRatio;
    const count = Math.min(24, Math.floor(carCarry));
    carCarry -= count;
    for (let i = 0; i < count; i++) {
      const seed = `car:${f.home.key}:${f.job.place.key}:${i}`;
      const rnd = seededRandom(seed);
      const classId: CitizenContext["classId"] =
        f.job.classHint === "engineers" ? (rnd() < 0.15 ? "elite" : "engineers") : "workers";
      const typeId =
        classId === "elite" ? "CAR-03" : classId === "engineers" ? (rnd() < 0.2 ? "CAR-05" : "CAR-02") : rnd() < 0.35 ? "CAR-04" : "CAR-01";
      const health = routeHealthStats(roadGraph, f.route);
      emitVehicle({
        seed,
        role: "commuter",
        vehicleTypeId: typeId,
        sectorId: f.sectorId,
        layer: "surface",
        graph: roadGraph,
        route: f.route,
        colorHex: CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)]!,
        ownerLabel: "Частное домохозяйство",
        originLabel: f.home.label,
        destinationLabel: f.job.place.label,
        cargo: null,
        passengers: { onboard: 1 + Math.floor(rnd() * 2), capacity: catalogs.vehiclesById.get(typeId)?.capacity ?? 4 },
        citizen: {
          sectorId: f.sectorId,
          classId,
          homeLabel: f.home.label,
          homeZoneId: f.homeZone.id,
          homeX: f.home.x,
          homeY: f.home.y,
          workLabel: f.job.place.label,
          workRoleRu: f.job.roleRu,
          workX: f.job.place.x,
          workY: f.job.place.y,
          commuteTiles: f.route.lengthTiles,
          commuteMode: "car",
          commuteMinHealth: health.min,
          busCovered: f.busCovered,
          metroCovered: f.metroCovered,
        },
        rnd,
      });
    }
  }

  // Nearest home for drivers of trucks, buses and trains
  const homeFor = (sectorId: SectorId, x: number, y: number) => {
    let best: { label: string; zoneId: string | null; x: number; y: number; busCovered: boolean; metroCovered: boolean } | null = null;
    let bestD = Infinity;
    for (const z of input.zones) {
      if (z.sectorId !== sectorId || !z.zoneKind.startsWith("RES")) continue;
      const [zx, zy] = zoneCenter(z);
      const d = Math.hypot(zx - x, zy - y);
      if (d < bestD) {
        bestD = d;
        best = {
          label: `Жилой квартал ${z.zoneKind} #${z.id}`,
          zoneId: z.id,
          x: zx,
          y: zy,
          busCovered: coveredBy(operatingStops, sectorId, zx, zy),
          metroCovered: coveredBy(operatingStations, sectorId, zx, zy),
        };
      }
    }
    return (
      best ?? { label: "Служебное общежитие при предприятии", zoneId: null, x, y, busCovered: false, metroCovered: false }
    );
  };

  // Freight trucks: every flow visible (1..8 trucks)
  for (const f of freightFlows) {
    const count = Math.max(1, Math.min(8, Math.ceil(f.trucksPerHour * 0.6)));
    const truck = catalogs.vehiclesById.get(f.truckTypeId)!;
    const health = routeHealthStats(roadGraph, f.route);
    const coInvested = f.originEntry.ownershipContour === "co_invested_10_90";
    const commodityRecipe = catalogs.commoditiesByName.get(f.commodity);
    for (let i = 0; i < count; i++) {
      const seed = `trk:${f.origin.key}:${f.dest.key}:${i}`;
      const rnd = seededRandom(seed);
      const capacityUnits = truck.capacity * unitTons(truck.capacityUnit) / unitTons(f.unit);
      const payload = Number((capacityUnits * (0.85 + rnd() * 0.15)).toFixed(1));
      const valueWcu = commodityRecipe
        ? mulRate(commodityRecipe.worldReferencePrice, payload)
        : 0n;
      const home = homeFor(f.sectorId, f.origin.x, f.origin.y);
      emitVehicle({
        seed,
        role: "freight",
        vehicleTypeId: f.truckTypeId,
        sectorId: f.sectorId,
        layer: "surface",
        graph: roadGraph,
        route: f.route,
        colorHex: TRUCK_COLORS[Math.floor(rnd() * TRUCK_COLORS.length)]!,
        ownerLabel: coInvested
          ? `АО «${f.originEntry.nameRu}» (доля Мэрии ${Math.round(f.originBuilding.cityEquityShare * 100)}%)`
          : `Мэрия — Контур Б («${f.originEntry.nameRu}»)`,
        originLabel: f.origin.label,
        destinationLabel: f.exportViaGateway
          ? `Экспорт: ${f.dest.label}`
          : f.border
            ? `${f.dest.label} (Сектор ${f.border.toSector}, через КПП #${f.border.postId})`
            : f.dest.label,
        cargo: {
          commodity: f.commodity,
          payload,
          capacity: Number(capacityUnits.toFixed(1)),
          unit: f.unit,
          valueWcu,
          exportViaGateway: f.exportViaGateway,
          ...(f.border
            ? { border: { postId: f.border.postId, toSector: f.border.toSector, importDuty: f.border.terms.importDuty } }
            : {}),
        },
        passengers: null,
        citizen: {
          sectorId: f.sectorId,
          classId: "workers",
          homeLabel: home.label,
          homeZoneId: home.zoneId,
          homeX: home.x,
          homeY: home.y,
          workLabel: f.origin.label,
          workRoleRu: "Водитель грузовика",
          workX: f.origin.x,
          workY: f.origin.y,
          commuteTiles: Math.hypot(home.x - f.origin.x, home.y - f.origin.y),
          commuteMode: "driver",
          commuteMinHealth: health.min,
          busCovered: home.busCovered,
          metroCovered: home.metroCovered,
        },
        rnd,
      });
    }
  }

  // Buses: the whole licensed fleet runs (≤ 12 shown per route)
  for (const trip of busTrips) {
    const color = BUS_COLORS[hashString(trip.route.id) % BUS_COLORS.length]!;
    const health = routeHealthStats(roadGraph, trip.path);
    const firstStop = buildingById.get(trip.route.stopBuildingIds[0]!)!;
    const lastStop = buildingById.get(trip.route.stopBuildingIds[trip.route.stopBuildingIds.length - 1]!)!;
    const depot = operational.find((b) => b.catalogId === "TRN-02" && b.sectorId === trip.route.sectorId)!;
    const [dx, dy] = buildingCenter(depot);
    for (let i = 0; i < Math.min(12, trip.route.fleetSize); i++) {
      const seed = `bus:${trip.route.id}:${i}`;
      const rnd = seededRandom(seed);
      const bus = catalogs.vehiclesById.get(trip.route.vehicleTypeId) ?? busType;
      const home = homeFor(trip.route.sectorId, dx, dy);
      emitVehicle({
        seed,
        role: "bus",
        vehicleTypeId: trip.route.vehicleTypeId,
        sectorId: trip.route.sectorId,
        layer: "surface",
        graph: roadGraph,
        route: trip.path,
        colorHex: color,
        ownerLabel: `${trip.route.operatorName} (лицензия маршрута «${trip.route.name}»)`,
        originLabel: `Остановка #${firstStop.id}`,
        destinationLabel: `Остановка #${lastStop.id} (${trip.route.stopBuildingIds.length} ост.)`,
        cargo: null,
        passengers: {
          onboard: Math.round((bus?.capacity ?? 90) * (0.2 + rnd() * 0.75)),
          capacity: bus?.capacity ?? 90,
        },
        citizen: {
          sectorId: trip.route.sectorId,
          classId: "workers",
          homeLabel: home.label,
          homeZoneId: home.zoneId,
          homeX: home.x,
          homeY: home.y,
          workLabel: `Автобусный парк #${depot.id}`,
          workRoleRu: "Водитель автобуса",
          workX: dx,
          workY: dy,
          commuteTiles: Math.hypot(home.x - dx, home.y - dy),
          commuteMode: "driver",
          commuteMinHealth: health.min,
          busCovered: home.busCovered,
          metroCovered: home.metroCovered,
        },
        rnd,
      });
    }
  }

  // Emergency responders with sirens, from their station to the incident
  for (const d of input.dispatches ?? []) {
    const station = buildingById.get(d.buildingId);
    if (!station) continue;
    const from = buildingPlace(station, roadGraph, BUILDING_SNAP_TILES);
    const to: Place = {
      key: `emg:${d.emergencyInstanceId}`,
      label: d.emergencyTitleRu,
      sectorId: d.sectorId,
      x: d.tileX,
      y: d.tileY,
      loc: locateOnGraph(roadGraph, d.tileX, d.tileY, 25),
    };
    const route = routeBetween(roadGraph, from, to);
    if (!route) continue;
    const seed = `svc:${d.emergencyInstanceId}:${d.vehicleTypeId}`;
    const rnd = seededRandom(seed);
    const home = homeFor(d.sectorId, from.x, from.y);
    const health = routeHealthStats(roadGraph, route);
    emitVehicle({
      seed,
      role: "service",
      vehicleTypeId: d.vehicleTypeId,
      sectorId: d.sectorId,
      layer: "surface",
      graph: roadGraph,
      route,
      colorHex: SERVICE_COLORS[d.vehicleTypeId] ?? 0xf59e0b,
      ownerLabel: `Мэрия — ${from.label}`,
      originLabel: from.label,
      destinationLabel: `Выезд на ЧП: ${d.emergencyTitleRu}`,
      cargo: null,
      passengers: { onboard: 2 + Math.floor(rnd() * 3), capacity: catalogs.vehiclesById.get(d.vehicleTypeId)?.capacity ?? 4 },
      citizen: {
        sectorId: d.sectorId,
        classId: d.vehicleTypeId === "MUN-03" ? "engineers" : "workers",
        homeLabel: home.label,
        homeZoneId: home.zoneId,
        homeX: home.x,
        homeY: home.y,
        workLabel: from.label,
        workRoleRu: RESPONDER_ROLE_RU[d.vehicleTypeId] ?? "Сотрудник городской службы",
        workX: from.x,
        workY: from.y,
        commuteTiles: Math.hypot(home.x - from.x, home.y - from.y),
        commuteMode: "driver",
        commuteMinHealth: health.min,
        busCovered: home.busCovered,
        metroCovered: home.metroCovered,
      },
      rnd,
    });
  }

  // Metro trains run underground (no road wear, no congestion)
  for (const line of metroLines) {
    const points: number[] = [];
    let lengthTiles = 0;
    let hours = 0;
    for (const leg of line.legs) {
      const start = points.length === 0 ? 0 : 2;
      for (let i = start; i < leg.points.length; i++) points.push(leg.points[i]!);
      lengthTiles += leg.lengthTiles;
      hours += leg.travelTimeHours;
    }
    const path: RouteResult = { points, lengthTiles, travelTimeHours: hours, edgeShares: line.legs.flatMap((l) => l.edgeShares) };
    const depot = operational.find((b) => b.catalogId === "TRN-10" && b.sectorId === line.sectorId)!;
    const [dx, dy] = buildingCenter(depot);
    const trains = Math.min(10, 2 * line.legs.length);
    for (let i = 0; i < trains; i++) {
      const seed = `metro:${line.sectorId}:${line.stations[0]!.key}:${i}`;
      const rnd = seededRandom(seed);
      const home = homeFor(line.sectorId, dx, dy);
      emitVehicle({
        seed,
        role: "metro",
        vehicleTypeId: "PT-07",
        sectorId: line.sectorId,
        layer: "underground",
        graph: metroGraph,
        route: path,
        colorHex: 0x818cf8,
        ownerLabel: "Метрополитен Мэрии (100% казна)",
        originLabel: line.stations[0]!.label,
        destinationLabel: `${line.stations[line.stations.length - 1]!.label} (${line.stations.length} ст.)`,
        cargo: null,
        passengers: { onboard: Math.round(1200 * (0.15 + rnd() * 0.8)), capacity: 1200 },
        citizen: {
          sectorId: line.sectorId,
          classId: "engineers",
          homeLabel: home.label,
          homeZoneId: home.zoneId,
          homeX: home.x,
          homeY: home.y,
          workLabel: `Метродепо #${depot.id}`,
          workRoleRu: "Машинист метро",
          workX: dx,
          workY: dy,
          commuteTiles: Math.hypot(home.x - dx, home.y - dy),
          commuteMode: "driver",
          commuteMinHealth: 100,
          busCovered: home.busCovered,
          metroCovered: home.metroCovered,
        },
        rnd,
      });
    }
  }

  // -----------------------------------------------------------------------------------------
  // 7. Sector transport statistics
  // -----------------------------------------------------------------------------------------
  const trafficBySeg = new Map(segmentTraffic.map((t) => [t.segmentId, t]));
  const sectors: SectorTransportStatsDto[] = input.sectors.map((ctx) => {
    const sid = ctx.sectorId;
    const roads = input.segments.filter((s) => s.sectorId === sid && isRoadKind(s.kind));
    let len = 0;
    let healthSum = 0;
    let serviceCostWcu = 0n;
    for (const s of roads) {
      const l = Math.hypot(s.toX - s.fromX, s.toY - s.fromY);
      len += l;
      healthSum += s.healthPercent * l;
      if (isRoadKind(s.kind)) serviceCostWcu += roadServiceMonthlyCost(s.kind, l * 10, ctx.roadServiceLevel);
    }
    const hh = sectorHouseholds.get(sid) ?? 0;
    const resTiles = sectorResTiles.get(sid) ?? 0;
    return {
      sectorId: sid,
      carTripsPerHour: Math.round(sectorCarTrips.get(sid) ?? 0),
      truckTripsPerHour: Number((sectorTruckTrips.get(sid) ?? 0).toFixed(1)),
      transitRidersPerHour: Math.round(sectorTransitRiders.get(sid) ?? 0),
      busRoutes: busTrips.filter((t) => t.route.sectorId === sid).length,
      busCoverageShare: hh > 0 ? Number(((sectorBusCoveredHh.get(sid) ?? 0) / hh).toFixed(3)) : 0,
      metroStations: metroStationsBySector.get(sid) ?? 0,
      metroOperational: metroOperationalBySector.get(sid) ?? false,
      metroCoverageShare: hh > 0 ? Number(((sectorMetroCoveredHh.get(sid) ?? 0) / hh).toFixed(3)) : 0,
      metroLandValueBoostShare: resTiles > 0 ? Number(((sectorMetroResTiles.get(sid) ?? 0) / resTiles).toFixed(3)) : 0,
      avgRoadHealth: len > 0 ? Number((healthSum / len).toFixed(1)) : 100,
      congestedSegments: roads.filter((s) => (trafficBySeg.get(s.id)?.volumeCapacityRatio ?? 0) > 0.85).length,
      damagedSegments: roads.filter((s) => s.healthPercent < 75).length,
      roadServiceLevel: ctx.roadServiceLevel,
      roadServiceMonthlyCostMinor: mulRate(serviceCostWcu, ctx.fxRatePerWcu).toString(),
    };
  });

  const metroZoneIds = new Set<string>();
  const busZoneIds = new Set<string>();
  for (const z of input.zones) {
    const [zx, zy] = zoneCenter(z);
    if (coveredBy(operatingStations, z.sectorId, zx, zy)) metroZoneIds.add(z.id);
    if (coveredBy(operatingStops, z.sectorId, zx, zy)) busZoneIds.add(z.id);
  }

  return {
    metroZoneIds,
    busZoneIds,
    crossBorderFlows,
    state: {
      version: input.version,
      gameHourOfDay: hour,
      vehicles: [...vehicles.values()].map((v) => v.dto),
      segments: segmentTraffic,
      sectors,
      busRoutes: busStatuses,
    },
    vehicles,
    citizens,
    segmentWearPerHour,
  };
}
