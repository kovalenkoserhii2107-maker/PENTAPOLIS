/**
 * Gas Network & Power Ring (Sprint 7, GDD §4.2, §4.3, §5.3).
 *
 * Gas: wells (EXT-07) feed plants connected to the same trunk pipeline network (INF-06), within
 * a sector or across a border post. Gasified plants produce more (sheet 07 Production Chains gas
 * multipliers: steel ×1.40, cement ×1.35, polymers ×1.50…) and emit less (sheet 19: −48..70%);
 * the gas turbine (ENG-02) generates only with gas. Short supply is shared pro rata.
 *
 * Power ring: sectors whose high-voltage lines (INF-09) meet at a border post pool their spare
 * capacity; a deficit is covered by neighbours' surplus at +20% of the wholesale price (sheet 12).
 */
import { parseCsv, parseNum } from "../csv.ts";
import { RAW_SHEETS } from "../catalogs/rawSheets.generated.ts";
import type { MasterCatalogs } from "../catalogs/index.ts";
import { computeBuildingAtLevel } from "../catalogs/buildings.ts";
import type { SectorId } from "../catalogs/visuals.ts";
import type { BuildingDto, NetworkSegmentDto, SectorGasStatsDto, SectorPowerRingDto } from "../protocol.ts";
import { buildNetworkGraph, connectedComponents, locateRectOnGraph, type GraphLink } from "../traffic/roadGraph.ts";
import { getCustomsTables } from "./customs.ts";

/** Thousand m³ of gas per game hour a gas-ready plant burns per level. */
export const GAS_DEMAND_PER_PLANT_LEVEL = 2;
/** Gas turbine (ENG-02) burn per level. */
export const GAS_DEMAND_PER_TURBINE_LEVEL = 6;
/** Tiles from a building's footprint to a pipeline / HV line for it to connect. */
const HOOKUP_TILES = 4;
/** Ring imports are paid at +20% (GDD §4.3). */
export const POWER_RING_PREMIUM = 0.2;

let cachedPowerPrice: number | null = null;

/** Base wholesale electricity price, $/MWh (sheet 12 City Systems). */
export function wholesalePowerPricePerMwh(): number {
  if (cachedPowerPrice === null) {
    const row = parseCsv(RAW_SHEETS["City Systems"] ?? "").find((r) => /base wholesale electricity price/i.test(r[1] ?? ""));
    cachedPowerPrice = parseNum(row?.[2], 45);
  }
  return cachedPowerPrice;
}

export interface GasNetworkInput {
  readonly catalogs: MasterCatalogs;
  readonly segments: readonly NetworkSegmentDto[];
  readonly buildings: readonly BuildingDto[];
  /** Pipeline joints through open border posts. */
  readonly links: readonly GraphLink[];
  readonly sectorIds: readonly SectorId[];
}

export interface GasNetworkResult {
  /** Output multiplier per building (1 = no gas). */
  readonly outputMultiplier: ReadonlyMap<string, number>;
  /** Pollution multiplier per building (1 = burning coal). */
  readonly pollutionMultiplier: ReadonlyMap<string, number>;
  /** Share of each gas turbine's demand that is met (0..1). */
  readonly turbineSupply: ReadonlyMap<string, number>;
  readonly sectors: readonly SectorGasStatsDto[];
}

const operational = (b: BuildingDto) => b.constructionProgress >= 1 && !b.stalledAwaitingPrivate;

export function runGasNetwork(input: GasNetworkInput): GasNetworkResult {
  const { catalogs } = input;
  const customs = getCustomsTables();
  const graph = buildNetworkGraph(input.segments, "pipeline", input.links);
  const labels = connectedComponents(graph);
  const componentOf = (b: BuildingDto): number | null => {
    if (graph.edges.length === 0) return null;
    const loc = locateRectOnGraph(graph, { x: b.tileX, y: b.tileY, width: b.width, depth: b.depth }, HOOKUP_TILES);
    return loc ? labels[graph.edges[loc.edgeId]!.a]! : null;
  };

  interface Node { b: BuildingDto; comp: number | null; supply: number; demand: number; boost: number; emissionsCut: number; turbine: boolean }
  const nodes: Node[] = [];
  for (const b of input.buildings) {
    if (!operational(b) || b.sectorId === "core") continue;
    const entry = catalogs.buildingsById.get(b.catalogId);
    if (!entry) continue;
    if (b.catalogId === "EXT-07" || b.catalogId === "EXT-05") {
      const baseCap = computeBuildingAtLevel(entry, catalogs.levelCurves, b.level).capacity;
      const cap = b.catalogId === "EXT-05" ? baseCap * 0.5 : baseCap;
      nodes.push({ b, comp: componentOf(b), supply: cap, demand: 0, boost: 1, emissionsCut: 0, turbine: false });
      continue;
    }
    if (b.catalogId === "ENG-02") {
      nodes.push({ b, comp: componentOf(b), supply: 0, demand: GAS_DEMAND_PER_TURBINE_LEVEL * b.level, boost: 1, emissionsCut: 0, turbine: true });
      continue;
    }
    const recipe = catalogs.commoditiesByName.get(entry.mainOutput);
    if (!recipe || recipe.gasOutputBoostMultiplier <= 1 || !["PRO", "CMP", "ASM"].includes(entry.prefix)) continue;
    const industry = customs.gasIndustries.find((g) => g.match.test(entry.mainOutput));
    nodes.push({
      b,
      comp: componentOf(b),
      supply: 0,
      demand: GAS_DEMAND_PER_PLANT_LEVEL * b.level,
      boost: recipe.gasOutputBoostMultiplier,
      emissionsCut: industry?.emissionsReduction ?? 0.5,
      turbine: false,
    });
  }

  // Pool supply and demand per pipeline component
  const compSupply = new Map<number, number>();
  const compDemand = new Map<number, number>();
  for (const n of nodes) {
    if (n.comp === null) continue;
    compSupply.set(n.comp, (compSupply.get(n.comp) ?? 0) + n.supply);
    compDemand.set(n.comp, (compDemand.get(n.comp) ?? 0) + n.demand);
  }
  const shareOf = (comp: number | null) => {
    if (comp === null) return 0;
    const d = compDemand.get(comp) ?? 0;
    return d > 0 ? Math.min(1, (compSupply.get(comp) ?? 0) / d) : 0;
  };
  const usedShareOfSupply = (comp: number | null) => {
    if (comp === null) return 0;
    const s = compSupply.get(comp) ?? 0;
    return s > 0 ? Math.min(1, (compDemand.get(comp) ?? 0) / s) : 0;
  };

  const outputMultiplier = new Map<string, number>();
  const pollutionMultiplier = new Map<string, number>();
  const turbineSupply = new Map<string, number>();
  const perSector = new Map<
    SectorId,
    { supply: number; demand: number; used: number; consumed: number; gasified: number; ready: number; boostSum: number; backupFuelOil: boolean }
  >();
  for (const sid of input.sectorIds) {
    perSector.set(sid, { supply: 0, demand: 0, used: 0, consumed: 0, gasified: 0, ready: 0, boostSum: 0, backupFuelOil: false });
  }

  for (const n of nodes) {
    const sid = n.b.sectorId as SectorId;
    const st = perSector.get(sid);
    const share = shareOf(n.comp);
    if (n.supply > 0) {
      if (st) {
        st.supply += n.supply;
        st.used += n.supply * usedShareOfSupply(n.comp);
      }
      continue;
    }
    if (n.turbine) {
      turbineSupply.set(n.b.id, share);
      if (st && share < 1) st.backupFuelOil = true;
    } else {
      outputMultiplier.set(n.b.id, 1 + (n.boost - 1) * share);
      pollutionMultiplier.set(n.b.id, 1 - n.emissionsCut * share);
      if (st) {
        st.ready += 1;
        if (share > 0.5) st.gasified += 1;
        st.boostSum += (n.boost - 1) * share;
      }
    }
    if (st) {
      st.demand += n.demand;
      st.consumed += n.demand * share;
    }
  }

  const sectors: SectorGasStatsDto[] = [...perSector].map(([sectorId, st]) => ({
    sectorId,
    supplyKm3PerHour: Number(st.supply.toFixed(2)),
    demandKm3PerHour: Number(st.demand.toFixed(2)),
    importedKm3PerHour: Number(Math.max(0, st.consumed - st.used).toFixed(2)),
    exportedKm3PerHour: Number(Math.max(0, st.used - st.consumed).toFixed(2)),
    gasifiedPlants: st.gasified,
    gasReadyPlants: st.ready,
    avgOutputBoost: st.ready > 0 ? Number((st.boostSum / st.ready).toFixed(3)) : 0,
    backupFuelOilBurned: st.backupFuelOil,
  }));
  return { outputMultiplier, pollutionMultiplier, turbineSupply, sectors };
}

export interface PowerRingInput {
  readonly segments: readonly NetworkSegmentDto[];
  readonly links: readonly GraphLink[];
  readonly supplyDemand: ReadonlyMap<SectorId, { readonly supplyMw: number; readonly demandMw: number }>;
}

/** Pools spare capacity between sectors whose HV grids meet at a border post. */
export function runPowerRing(input: PowerRingInput): SectorPowerRingDto[] {
  const graph = buildNetworkGraph(input.segments, "power", input.links);
  const labels = connectedComponents(graph);
  const segSector = new Map(input.segments.map((s) => [s.id, s.sectorId]));

  // Sectors present in each HV component
  const compSectors = new Map<number, Set<SectorId>>();
  for (const e of graph.edges) {
    const sid = segSector.get(e.segmentId);
    if (sid === undefined) continue;
    const comp = labels[e.a]!;
    const set = compSectors.get(comp) ?? new Set<SectorId>();
    set.add(sid);
    compSectors.set(comp, set);
  }
  const partnersOf = new Map<SectorId, Set<SectorId>>();
  for (const set of compSectors.values()) {
    if (set.size < 2) continue;
    for (const s of set) {
      const p = partnersOf.get(s) ?? new Set<SectorId>();
      for (const o of set) if (o !== s) p.add(o);
      partnersOf.set(s, p);
    }
  }

  // Each connected group pools surplus to cover deficits pro rata
  const imported = new Map<SectorId, number>();
  const exported = new Map<SectorId, number>();
  const visited = new Set<SectorId>();
  for (const start of input.supplyDemand.keys()) {
    if (visited.has(start) || !partnersOf.has(start)) continue;
    const group: SectorId[] = [];
    const stack = [start];
    while (stack.length > 0) {
      const s = stack.pop()!;
      if (visited.has(s)) continue;
      visited.add(s);
      group.push(s);
      for (const o of partnersOf.get(s) ?? []) if (!visited.has(o)) stack.push(o);
    }
    const bal = group.map((s) => {
      const sd = input.supplyDemand.get(s) ?? { supplyMw: 0, demandMw: 0 };
      return { s, net: sd.supplyMw - sd.demandMw };
    });
    const surplus = bal.reduce((a, b) => a + Math.max(0, b.net), 0);
    const deficit = bal.reduce((a, b) => a + Math.max(0, -b.net), 0);
    const moved = Math.min(surplus, deficit);
    for (const b of bal) {
      if (b.net < 0 && deficit > 0) imported.set(b.s, (moved * -b.net) / deficit);
      if (b.net > 0 && surplus > 0) exported.set(b.s, (moved * b.net) / surplus);
    }
  }

  return [...input.supplyDemand].map(([sectorId, sd]) => ({
    sectorId,
    supplyMw: sd.supplyMw,
    demandMw: sd.demandMw,
    importedMw: Number((imported.get(sectorId) ?? 0).toFixed(1)),
    exportedMw: Number((exported.get(sectorId) ?? 0).toFixed(1)),
    partners: [...(partnersOf.get(sectorId) ?? [])].sort(),
  }));
}
