/**
 * Server-side glue for Sprint 7 (border posts, cross-border trade, gas & power ring links).
 *
 * Pure helpers over the world's segments, buildings and border-post records; `WorldSimulation`
 * owns the state and calls these on placement, policy changes, the tactical tick and the monthly
 * settlement.
 */
import {
  BLOCKADE_QUEUE_MINUTES,
  CARGO_LANES,
  LANE_NAMES_RU,
  OwnerCode,
  SurfaceType,
  VISA_NAMES_RU,
  borderQueueMinutes,
  cargoLaneOf,
  defaultBorderPolicy,
  getCustomsTables,
  laneOpen,
  laneSmugglingRate,
  mulRate,
  postTruckCapacityPerHour,
  type BorderPostDto,
  type BorderPostStatsDto,
  type BorderSidePolicyDto,
  type BuildingDto,
  type CargoLaneId,
  type CrossBorderFlow,
  type CrossingTerms,
  type GraphLink,
  type MaterialTradePartner,
  type NetworkKind,
  type NetworkSegmentDto,
  type PeninsulaMapData,
  type SectorId,
} from "@pentapolis/shared-sim";

const LINK_SNAP_EXTRA_TILES = 10;

/** Which sectors a footprint covers; a border post must straddle exactly two sectors, all on land. */
export function borderPostSides(
  map: PeninsulaMapData,
  sectorId: SectorId,
  x: number,
  y: number,
  w: number,
  d: number
): { ok: true; neighbor: SectorId } | { ok: false; reason: string } {
  const owners = new Set<number>();
  for (let dy = 0; dy < d; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return { ok: false, reason: "КПП выходит за пределы карты" };
      const idx = ty * map.width + tx;
      if (map.surface[idx] !== SurfaceType.Land) return { ok: false, reason: "КПП строится только на суше" };
      owners.add(map.owner[idx]!);
    }
  }
  const others = [...owners].filter((o) => o !== sectorId);
  if (!owners.has(sectorId) || others.length !== 1 || others[0]! < OwnerCode.Sector1 || others[0]! > OwnerCode.Sector5) {
    return { ok: false, reason: "КПП ставится прямо на линии границы вашего сектора с одним соседом" };
  }
  return { ok: true, neighbor: others[0] as SectorId };
}

export function newBorderPost(building: BuildingDto, sectorA: SectorId, sectorB: SectorId): BorderPostDto {
  return {
    id: building.id,
    sectorA,
    sectorB,
    tileX: building.tileX,
    tileY: building.tileY,
    width: building.width,
    depth: building.depth,
    sides: [defaultBorderPolicy(sectorA), defaultBorderPolicy(sectorB)],
    pending: [],
  };
}

export const sideOf = (post: BorderPostDto, sectorId: SectorId): BorderSidePolicyDto | undefined =>
  post.sides.find((s) => s.sectorId === sectorId);

/**
 * Network joints through border posts: for each post, the nearest segment end of each side within
 * reach of the post on the given layer. Posts without a network end on both sides are skipped.
 */
export function borderLinks(
  posts: readonly BorderPostDto[],
  segments: Iterable<NetworkSegmentDto>,
  kinds: readonly NetworkKind[],
  delayHours: (post: BorderPostDto) => number = () => 0
): GraphLink[] {
  const segs = [...segments].filter((s) => kinds.includes(s.kind) && !s.id.startsWith("GW-STUB-"));
  const links: GraphLink[] = [];
  for (const post of posts) {
    const cx = post.tileX + post.width / 2;
    const cy = post.tileY + post.depth / 2;
    const reach = Math.max(post.width, post.depth) / 2 + LINK_SNAP_EXTRA_TILES;
    const endOf = (sectorId: SectorId): [number, number] | null => {
      let best: [number, number] | null = null;
      let bestD = reach;
      for (const s of segs) {
        if (s.sectorId !== sectorId) continue;
        for (const [px, py] of [[s.fromX, s.fromY], [s.toX, s.toY]] as const) {
          const dd = Math.hypot(px - cx, py - cy);
          if (dd <= bestD) {
            bestD = dd;
            best = [px, py];
          }
        }
      }
      return best;
    };
    const a = endOf(post.sectorA);
    const b = endOf(post.sectorB);
    if (!a || !b) continue;
    links.push({ id: post.id, ax: a[0], ay: a[1], bx: b[0], by: b[1], snapTiles: 0.6, delayHours: delayHours(post) });
  }
  return links;
}

/** Customs terms for a commodity crossing a post from `from` into `to`. */
export function crossingTerms(post: BorderPostDto | undefined, from: SectorId, to: SectorId, commodity: string): CrossingTerms | null {
  if (!post) return null;
  const exporter = sideOf(post, from);
  const importer = sideOf(post, to);
  if (!exporter || !importer) return null;
  const lane = cargoLaneOf(commodity);
  const lanes = getCustomsTables().lanes;
  return {
    allowed: laneOpen(exporter, importer, lane),
    importDuty: importer.importDuty[lane] + (lanes.get(lane)?.exciseRate ?? 0),
    exportDuty: exporter.exportDuty[lane],
    smuggling: laneSmugglingRate(importer, lane),
  };
}

/** Material trade partners for developers: each linked post lets both sides buy each other's surplus. */
export function materialTradePartners(posts: readonly BorderPostDto[], roadLinkedIds: ReadonlySet<string>): MaterialTradePartner[] {
  const partners: MaterialTradePartner[] = [];
  for (const post of posts) {
    if (!roadLinkedIds.has(post.id)) continue;
    for (const [buyer, seller] of [[post.sectorA, post.sectorB], [post.sectorB, post.sectorA]] as const) {
      const imp = sideOf(post, buyer)!;
      const exp = sideOf(post, seller)!;
      const laneOfMaterial = (m: string): CargoLaneId => cargoLaneOf(m);
      partners.push({
        buyer,
        seller,
        allowed: (m) => laneOpen(exp, imp, laneOfMaterial(m)),
        importDuty: (m) => imp.importDuty[laneOfMaterial(m)],
        exportDuty: (m) => exp.exportDuty[laneOfMaterial(m)],
      });
    }
  }
  return partners;
}

/** Strictest inspection of the two sides governs clearance throughput. */
const postInspection = (post: BorderPostDto) =>
  post.sides.some((s) => s.inspection === "strict") ? ("strict" as const) : ("green" as const);

/**
 * Per-post statistics for one game month: trucks, queue, border crossers and each side's duty,
 * visa fees and the cargo value lost to smuggling (local minor units).
 */
export function borderPostStats(params: {
  readonly post: BorderPostDto;
  readonly level: number;
  readonly roadLinked: boolean;
  readonly flows: readonly CrossBorderFlow[];
  readonly fxRatePerWcu: (sectorId: SectorId) => number;
  readonly residents: (sectorId: SectorId) => number;
}): BorderPostStatsDto {
  const { post } = params;
  const customs = getCustomsTables();
  const flows = params.flows.filter((f) => f.postId === post.id);
  const trucks = flows.reduce((s, f) => s + f.trucksPerHour, 0);
  const inspection = postInspection(post);
  const capacity = postTruckCapacityPerHour(params.level, inspection);
  const laneQueue = Math.max(0, ...flows.map((f) => customs.lanes.get(cargoLaneOf(f.commodity))?.queueMinutes ?? 0));
  const visaQueue = Math.max(...post.sides.map((s) => customs.visas.get(s.visaRegime)?.queueMinutes ?? 0));
  const queueMinutes = borderQueueMinutes({
    trucksPerHour: trucks,
    capacityPerHour: capacity,
    baseQueueMinutes: Math.max(laneQueue, visaQueue),
    inspection,
  });

  // People: the stricter regime caps crossers; sanitary quarantine blocks passenger/migration crossers completely
  const quarantined = post.sides.some((s) => s.sanitaryQuarantine === true);
  const regimes = post.sides.map((s) => customs.visas.get(s.visaRegime)!);
  const regimeCrossers = Math.min(...regimes.map((r) => r.monthlyCrossers));
  const popScale = Math.max(0.02, Math.min(1, (params.residents(post.sectorA) + params.residents(post.sectorB)) / 100_000));
  const crossers = params.roadLinked && !quarantined ? Math.min(50_000 * params.level, Math.round(regimeCrossers * popScale)) : 0;

  const revenue = post.sides.map((side) => {
    const fx = params.fxRatePerWcu(side.sectorId);
    let duty = 0n;
    let smuggled = 0n;
    for (const f of flows) {
      const monthValue = mulRate(f.valueWcuPerHour, 720 * fx);
      if (f.toSector === side.sectorId) {
        duty += mulRate(monthValue, f.terms.importDuty * (1 - f.terms.smuggling));
        smuggled += mulRate(monthValue, f.terms.smuggling);
      } else if (f.fromSector === side.sectorId) {
        duty += mulRate(monthValue, f.terms.exportDuty * (1 - f.terms.smuggling));
      } else if (side.transitDuty) {
        const lane = cargoLaneOf(f.commodity);
        const tRate = side.transitDuty[lane] ?? 0;
        if (tRate > 0) duty += mulRate(monthValue, tRate * (1 - f.terms.smuggling));
      }
    }
    const regime = customs.visas.get(side.visaRegime)!;
    // Half the crossers enter this side and pay its visa fee; smugglers of people pay nothing
    const visa = mulRate(BigInt(Math.round(regime.entryFeeUnits * 100)), (crossers / 2) * (1 - regime.smugglingRate) * fx);
    return { sectorId: side.sectorId, dutyMinor: duty.toString(), visaMinor: visa.toString(), smuggledValueMinor: smuggled.toString() };
  });

  return {
    postId: post.id,
    roadLinked: params.roadLinked,
    trucksPerHour: Number(trucks.toFixed(2)),
    capacityTrucksPerHour: capacity,
    queueMinutes,
    crossersPerMonth: crossers,
    flows: flows.map((f) => ({
      fromSector: f.fromSector,
      toSector: f.toSector,
      lane: cargoLaneOf(f.commodity),
      commodity: f.commodity,
      trucksPerHour: Number(f.trucksPerHour.toFixed(2)),
      valuePerMonthWcuMinor: (f.valueWcuPerHour * 720n).toString(),
    })),
    revenue,
  };
}

export function isBlockaded(stats: BorderPostStatsDto): boolean {
  return stats.queueMinutes >= BLOCKADE_QUEUE_MINUTES;
}

/** Human summary of a policy for chat & notices. */
export function describePolicy(policy: BorderSidePolicyDto): string {
  const duties = CARGO_LANES.filter((l) => policy.importDuty[l] > 0.3).map((l) => `${LANE_NAMES_RU[l].split(" ")[0]} ${Math.round(policy.importDuty[l] * 100)}%`);
  const transits = policy.transitDuty
    ? CARGO_LANES.filter((l) => (policy.transitDuty?.[l] ?? 0) > 0.15).map(
        (l) => `транзит ${LANE_NAMES_RU[l].split(" ")[0]} ${Math.round((policy.transitDuty?.[l] ?? 0) * 100)}%`
      )
    : [];
  const embargo = policy.embargo.map((l) => LANE_NAMES_RU[l].split(" ")[0]);
  return [
    VISA_NAMES_RU[policy.visaRegime],
    duties.length > 0 ? `пошлины: ${duties.join(", ")}` : "",
    transits.length > 0 ? transits.join(", ") : "",
    embargo.length > 0 ? `эмбарго: ${embargo.join(", ")}` : "",
    policy.inspection === "strict" ? "жёсткий досмотр" : "",
    policy.sanitaryQuarantine ? "санкарантин (−90% эпидемий)" : "",
    policy.gasValveOpen === false ? "вентиль трубы ПЕРЕКРЫТ" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

