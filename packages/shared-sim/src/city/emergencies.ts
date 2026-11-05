/**
 * Live Urban Emergencies & Service Dispatch (Sprint 6, GDD §6.6: 12 emergencies with responders).
 *
 * Emergencies arise from the real state of a sector (no fire station, roads below 40%, smoke,
 * no landfill, power deficit, unemployment...), each with a daily probability rolled from a
 * deterministic seed. The nearest operational responder (catalog `responderBuildingId`) is routed
 * over the road graph; its crew works on site and resolves the emergency. Without a responder the
 * emergency drags on three times longer and leaves damage (a burnt plant loses a level, a crash
 * further wrecks the road).
 *
 * KPP blockades and sea storms need customs posts and ports (Sprint 7) and stay admin-only.
 */
import type { MasterCatalogs } from "../catalogs/index.ts";
import { CANONICAL_EMERGENCIES, type EmergencyId } from "../catalogs/sectorsAndLevers.ts";
import type { SectorId } from "../catalogs/visuals.ts";
import type { ActiveEmergencyDto, BuildingDto, DistrictDto, NetworkSegmentDto, ZoneDto } from "../protocol.ts";
import { buildNetworkGraph, findRoute, locateOnGraph, locateRectOnGraph } from "../traffic/roadGraph.ts";
import { isRoadKind } from "../traffic/roadPhysics.ts";
import { hashString, seededRandom } from "../traffic/trafficModel.ts";

/** Responder vehicle per emergency (sheet 07 municipal fleet). */
export const RESPONDER_VEHICLE: Readonly<Partial<Record<EmergencyId, string>>> = {
  FIRE: "MUN-04",
  PIPE_BURST: "MUN-09",
  ROAD_CRASH: "MUN-01",
  LABOR_STRIKE: "MUN-02",
  BANK_HEIST: "MUN-01",
  COAL_SMOG: "MUN-03",
  RIVER_POLLUTION: "MUN-09",
  GARBAGE_COLLAPSE: "MUN-06",
  PEAK_BLACKOUT: "MUN-09",
};

/** Second responder: ambulances join crashes and fires when a clinic or hospital exists. */
const AMBULANCE_FOR: ReadonlySet<EmergencyId> = new Set(["ROAD_CRASH", "FIRE"]);

/** Hours of on-site work once the crew arrives. */
export const ON_SITE_HOURS: Readonly<Partial<Record<EmergencyId, number>>> = {
  FIRE: 1.5,
  PIPE_BURST: 3,
  ROAD_CRASH: 1,
  LABOR_STRIKE: 6,
  BANK_HEIST: 2,
  COAL_SMOG: 12,
  RIVER_POLLUTION: 24,
  GARBAGE_COLLAPSE: 8,
  PEAK_BLACKOUT: 2,
};
export const UNATTENDED_DURATION_MULTIPLIER = 3;
/** At most this many organic emergencies run at once in one sector. */
export const MAX_ACTIVE_EMERGENCIES_PER_SECTOR = 3;
/** FIRE_CODE decree: −40% fires (GDD §6.6). */
export const FIRE_CODE_FIRE_MULTIPLIER = 0.6;

export interface EmergencySectorInput {
  readonly sectorId: SectorId;
  readonly activeDecreeIds: readonly string[];
  readonly hardshipShare: number;
  readonly annualInflation: number;
  readonly powerDeficit: boolean;
}

export interface EmergencyRollInput {
  readonly catalogs: MasterCatalogs;
  readonly worldId: string;
  readonly gameDay: number;
  readonly sectors: readonly EmergencySectorInput[];
  readonly buildings: readonly BuildingDto[];
  readonly zones: readonly ZoneDto[];
  readonly segments: readonly NetworkSegmentDto[];
  readonly districts: readonly DistrictDto[];
  readonly active: readonly ActiveEmergencyDto[];
}

export interface EmergencySpawn {
  readonly emergencyId: EmergencyId;
  readonly sectorId: SectorId;
  readonly tileX: number;
  readonly tileY: number;
  readonly targetRef: string | null;
  readonly causeRu: string;
}

const centerOf = (b: { tileX: number; tileY: number; width: number; depth: number }): [number, number] => [
  b.tileX + b.width / 2,
  b.tileY + b.depth / 2,
];

/**
 * Rolls one game day of organic emergencies for every sector. Deterministic per world, day and sector.
 */
export function rollDailyEmergencies(input: EmergencyRollInput): EmergencySpawn[] {
  const spawns: EmergencySpawn[] = [];
  for (const sec of input.sectors) {
    const sid = sec.sectorId;
    const activeHere = input.active.filter((e) => e.sectorId === sid && e.emergencyId !== "FROZEN_CONSTRUCTION");
    let slots = MAX_ACTIVE_EMERGENCIES_PER_SECTOR - activeHere.length;
    if (slots <= 0) continue;

    const ops = input.buildings.filter((b) => b.sectorId === sid && b.constructionProgress >= 1 && !b.stalledAwaitingPrivate);
    const zones = input.zones.filter((z) => z.sectorId === sid && z.occupancyRatio > 0.05);
    const districts = input.districts.filter((d) => d.sectorId === sid);
    if (ops.length === 0 && zones.length === 0) continue;
    const has = (id: string) => ops.some((b) => b.catalogId === id);
    const rnd = seededRandom(`emg:${input.worldId}:${input.gameDay}:${sid}`);
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length) % list.length]!;
    const avg = (f: (d: DistrictDto) => number) => (districts.length > 0 ? districts.reduce((s, d) => s + f(d), 0) / districts.length : 0);
    const decree = (id: string) => sec.activeDecreeIds.includes(id);
    const running = new Set(activeHere.map((e) => e.emergencyId));

    const candidates: Array<{ id: EmergencyId; p: number; at: () => Omit<EmergencySpawn, "emergencyId" | "sectorId" | "causeRu">; cause: string }> = [];
    const atBuilding = (list: readonly BuildingDto[]) => () => {
      const b = pick(list);
      const [x, y] = centerOf(b);
      return { tileX: Math.round(x), tileY: Math.round(y), targetRef: b.id };
    };
    const atZone = (list: readonly ZoneDto[]) => () => {
      const z = pick(list);
      return { tileX: Math.round(z.x + z.width / 2), tileY: Math.round(z.y + z.depth / 2), targetRef: z.id };
    };

    const burnable = ops.filter((b) => !b.catalogId.startsWith("TRN-01"));
    if (burnable.length > 0) {
      const fireCover = avg((d) => d.coverage.fire);
      candidates.push({
        id: "FIRE",
        p: 0.04 * (1 - 0.8 * fireCover) * (decree("FIRE_CODE") ? FIRE_CODE_FIRE_MULTIPLIER : 1),
        at: atBuilding(burnable),
        cause: fireCover < 0.5 ? "нет пожарного депо рядом" : "износ проводки",
      });
    }
    const brokenRoads = input.segments.filter((s) => s.sectorId === sid && isRoadKind(s.kind) && s.healthPercent < 40);
    if (brokenRoads.length > 0) {
      candidates.push({
        id: "ROAD_CRASH",
        p: Math.min(0.6, 0.2 * brokenRoads.length),
        at: () => {
          const s = pick(brokenRoads);
          return { tileX: Math.round((s.fromX + s.toX) / 2), tileY: Math.round((s.fromY + s.toY) / 2), targetRef: s.id };
        },
        cause: "дорога в аварийном состоянии (<40%)",
      });
    }
    const banks = ops.filter((b) => b.catalogId === "BIZ-11" || b.catalogId === "BIZ-07" || b.catalogId.startsWith("FIN-"));
    if (banks.length > 0) {
      candidates.push({ id: "BANK_HEIST", p: avg((d) => d.crimeRate), at: atBuilding(banks), cause: "высокая преступность" });
    }
    const plants = ops.filter((b) => /^(PRO|CMP|ASM|EXT)-/.test(b.catalogId));
    if (plants.length > 0 && (sec.hardshipShare > 0.08 || sec.annualInflation > 0.1)) {
      candidates.push({ id: "LABOR_STRIKE", p: 0.06, at: atBuilding(plants), cause: "реальные зарплаты падают" });
    }
    const smoky = districts.filter((d) => d.ecology < 0.35);
    if (smoky.length > 0) {
      candidates.push({
        id: "COAL_SMOG",
        p: 0.12 * (decree("GAS_SUBSIDY") ? 0.5 : 1),
        at: atZone(zones.filter((z) => smoky.some((d) => d.zoneId === z.id))),
        cause: "дым заводов над жилыми кварталами",
      });
    }
    const households = zones.reduce((s, z) => s + z.width * z.depth * z.occupancyRatio, 0);
    if (households > 400 && !has("UTL-03") && !has("UTL-04") && zones.length > 0) {
      candidates.push({
        id: "GARBAGE_COLLAPSE",
        p: 0.15 * (decree("WASTE_SORTING") ? 0.6 : 1),
        at: atZone(zones),
        cause: "нет полигона или мусороперерабатывающего завода",
      });
    }
    if (sec.powerDeficit && zones.length > 0) {
      candidates.push({ id: "PEAK_BLACKOUT", p: 0.3, at: atZone(zones), cause: "мощности не хватает в вечерний пик" });
    }
    const wetIndustry = ops.filter((b) => /^(PRO|CMP)-/.test(b.catalogId));
    if (wetIndustry.length >= 2 && !has("UTL-02")) {
      candidates.push({ id: "RIVER_POLLUTION", p: 0.08, at: atBuilding(wetIndustry), cause: "нет очистных сооружений" });
    }
    const roads = input.segments.filter((s) => s.sectorId === sid && isRoadKind(s.kind) && !s.id.startsWith("GW-STUB-"));
    if (roads.length > 0) {
      candidates.push({
        id: "PIPE_BURST",
        p: 0.02,
        at: () => {
          const s = pick(roads);
          return { tileX: Math.round((s.fromX + s.toX) / 2), tileY: Math.round((s.fromY + s.toY) / 2), targetRef: s.id };
        },
        cause: "старый коллектор под дорогой",
      });
    }

    for (const c of candidates) {
      if (slots <= 0) break;
      if (running.has(c.id)) continue;
      if (rnd() >= c.p) continue;
      spawns.push({ emergencyId: c.id, sectorId: sid, causeRu: c.cause, ...c.at() });
      slots -= 1;
    }
  }
  return spawns;
}

export interface DispatchedResponder {
  readonly buildingId: string;
  readonly vehicleTypeId: string;
  readonly etaHours: number;
  readonly path: readonly number[];
}

/**
 * Routes the nearest operational responders of the sector to an emergency over the road graph.
 * Returns an empty list when no responder building exists or none is reachable by road.
 */
export function planDispatch(params: {
  readonly catalogs: MasterCatalogs;
  readonly emergencyId: EmergencyId;
  readonly sectorId: SectorId;
  readonly tileX: number;
  readonly tileY: number;
  readonly buildings: readonly BuildingDto[];
  readonly segments: readonly NetworkSegmentDto[];
}): DispatchedResponder[] {
  const spec = CANONICAL_EMERGENCIES.find((e) => e.id === params.emergencyId);
  const vehicle = RESPONDER_VEHICLE[params.emergencyId];
  if (!spec?.responderBuildingId || !vehicle) return [];
  const graph = buildNetworkGraph(params.segments, "road");
  const target = locateOnGraph(graph, params.tileX, params.tileY, 25);
  if (!target) return [];

  const routeFrom = (catalogIds: readonly string[], vehicleTypeId: string): DispatchedResponder | null => {
    let best: DispatchedResponder | null = null;
    for (const b of params.buildings) {
      if (!catalogIds.includes(b.catalogId) || b.sectorId !== params.sectorId) continue;
      if (b.constructionProgress < 1 || b.stalledAwaitingPrivate) continue;
      const from = locateRectOnGraph(graph, { x: b.tileX, y: b.tileY, width: b.width, depth: b.depth }, 10);
      if (!from) continue;
      const route = findRoute(graph, from, target);
      if (!route) continue;
      // Sirens: responders run at ~1.4x the posted speed
      const eta = route.travelTimeHours / 1.4;
      if (!best || eta < best.etaHours) {
        best = { buildingId: b.id, vehicleTypeId, etaHours: eta, path: route.points };
      }
    }
    return best;
  };

  const out: DispatchedResponder[] = [];
  const main = routeFrom([spec.responderBuildingId], vehicle);
  if (main) out.push(main);
  if (AMBULANCE_FOR.has(params.emergencyId)) {
    const amb = routeFrom(["HLT-01", "HLT-02"], "MUN-03");
    if (amb) out.push(amb);
  }
  return out;
}

/** Stable short id for an emergency instance. */
export function emergencyInstanceId(worldId: string, day: number, sectorId: SectorId, emergencyId: string): string {
  return `emg-${(hashString(`${worldId}:${day}:${sectorId}:${emergencyId}`) % 900_000) + 100_000}`;
}
