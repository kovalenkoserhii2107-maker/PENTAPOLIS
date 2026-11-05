/**
 * Network Graph & Routing for 90°/45° Roads, Rail and Metro Tunnels (Sprint 5).
 *
 * Segments are straight 8-directional tile rays. The graph places a node at every segment
 * endpoint and at every tile shared by two or more segments (T-junctions and crossings),
 * then splits segments into edges between consecutive nodes. Routing is A* over travel time
 * (`length / (speedLimit × roadHealthFactor) × congestion`), from and to arbitrary map points
 * snapped onto the nearest edge.
 */
import type { NetworkKind } from "../map/PeninsulaGrid.ts";
import {
  congestionTravelTimeFactor,
  isRoadKind,
  roadHealthSpeedFactor,
  trackSpeedLimitKmh,
} from "./roadPhysics.ts";

export type GraphLayer = "road" | "rail" | "metro" | "pipeline" | "power";

/**
 * A connector between two network ends that are not on one straight segment, e.g. the two
 * sides of a border post (Sprint 7). It joins the nearest graph nodes to both points.
 */
export interface GraphLink {
  readonly id: string;
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  /** Max tiles from each point to the node it attaches to. */
  readonly snapTiles: number;
  /** Extra travel time through the link (customs clearance), hours. */
  readonly delayHours?: number;
}

export interface GraphSegmentInput {
  readonly id: string;
  readonly kind: NetworkKind;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly healthPercent: number;
}

export interface GraphNode {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly edgeIds: number[];
}

export interface GraphEdge {
  readonly id: number;
  readonly segmentId: string;
  readonly kind: NetworkKind;
  readonly a: number;
  readonly b: number;
  readonly lengthTiles: number;
  readonly speedLimitKmh: number;
  readonly healthPercent: number;
  /** Fixed extra hours on top of driving (border clearance). */
  readonly delayHours?: number;
  /** Set when the edge is a cross-border link rather than a built segment. */
  readonly linkId?: string;
}

export interface NetworkGraph {
  readonly layer: GraphLayer;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface EdgeLocation {
  readonly edgeId: number;
  /** 0 at node `a`, 1 at node `b`. */
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly distance: number;
}

export interface RouteResult {
  /** Flat polyline `[x0, y0, x1, y1, ...]` in tile coordinates. */
  readonly points: readonly number[];
  readonly lengthTiles: number;
  readonly travelTimeHours: number;
  /** Edges traversed with the traversed fraction of each (for flow & wear accounting). */
  readonly edgeShares: ReadonlyArray<{ readonly edgeId: number; readonly share: number }>;
}

export function layerOfKind(kind: NetworkKind): GraphLayer | null {
  if (isRoadKind(kind)) return "road";
  if (kind === "rail") return "rail";
  if (kind === "metro_tunnel") return "metro";
  if (kind === "pipeline") return "pipeline";
  if (kind === "hv_power") return "power";
  return null;
}

function rasterize(seg: GraphSegmentInput): Array<[number, number]> {
  const dx = seg.toX - seg.fromX;
  const dy = seg.toY - seg.fromY;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const tiles: Array<[number, number]> = [];
  for (let s = 0; s <= steps; s++) {
    tiles.push([seg.fromX + sx * s, seg.fromY + sy * s]);
  }
  return tiles;
}

const tileKey = (x: number, y: number): number => y * 4096 + x;

/** Builds the graph of one layer (`road`, `rail` or `metro`) from placed network segments. */
export function buildNetworkGraph(
  segments: readonly GraphSegmentInput[],
  layer: GraphLayer,
  links: readonly GraphLink[] = []
): NetworkGraph {
  const layerSegs = segments
    .filter((s) => layerOfKind(s.kind) === layer)
    .filter((s) => s.fromX !== s.toX || s.fromY !== s.toY)
    .slice()
    .sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));

  const raster = layerSegs.map(rasterize);
  const usage = new Map<number, number>();
  const nodeTiles = new Set<number>();
  raster.forEach((tiles) => {
    const first = tiles[0]!;
    const last = tiles[tiles.length - 1]!;
    nodeTiles.add(tileKey(first[0], first[1]));
    nodeTiles.add(tileKey(last[0], last[1]));
    for (const [x, y] of tiles) {
      const k = tileKey(x, y);
      usage.set(k, (usage.get(k) ?? 0) + 1);
    }
  });
  for (const [k, n] of usage) {
    if (n >= 2) nodeTiles.add(k);
  }

  const nodes: GraphNode[] = [];
  const nodeByTile = new Map<number, number>();
  const nodeAt = (x: number, y: number): number => {
    const k = tileKey(x, y);
    let id = nodeByTile.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodes.push({ id, x, y, edgeIds: [] });
      nodeByTile.set(k, id);
    }
    return id;
  };

  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  layerSegs.forEach((seg, si) => {
    const tiles = raster[si]!;
    const diag = seg.fromX !== seg.toX && seg.fromY !== seg.toY;
    const stepLen = diag ? Math.SQRT2 : 1;
    let startIdx = 0;
    for (let i = 1; i < tiles.length; i++) {
      const [x, y] = tiles[i]!;
      if (!nodeTiles.has(tileKey(x, y))) continue;
      const [sx0, sy0] = tiles[startIdx]!;
      const a = nodeAt(sx0, sy0);
      const b = nodeAt(x, y);
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (a !== b && !edgeKeys.has(key)) {
        edgeKeys.add(key);
        const edge: GraphEdge = {
          id: edges.length,
          segmentId: seg.id,
          kind: seg.kind,
          a,
          b,
          lengthTiles: (i - startIdx) * stepLen,
          speedLimitKmh: trackSpeedLimitKmh(seg.kind),
          healthPercent: seg.healthPercent,
        };
        edges.push(edge);
        nodes[a]!.edgeIds.push(edge.id);
        nodes[b]!.edgeIds.push(edge.id);
      }
      startIdx = i;
    }
  });

  // Cross-border links join the nearest nodes on each side
  const nearestNode = (x: number, y: number, maxD: number): number => {
    let best = -1;
    let bestD = maxD;
    for (const n of nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  };
  for (const link of links) {
    const a = nearestNode(link.ax, link.ay, link.snapTiles);
    const b = nearestNode(link.bx, link.by, link.snapTiles);
    if (a < 0 || b < 0 || a === b) continue;
    const na = nodes[a]!;
    const nb = nodes[b]!;
    const edge: GraphEdge = {
      id: edges.length,
      segmentId: link.id,
      kind: layer === "road" ? "street_2lane" : layer === "pipeline" ? "pipeline" : layer === "power" ? "hv_power" : layer === "metro" ? "metro_tunnel" : "rail",
      a,
      b,
      lengthTiles: Math.max(1, Math.hypot(na.x - nb.x, na.y - nb.y)),
      speedLimitKmh: 30,
      healthPercent: 100,
      delayHours: link.delayHours ?? 0,
      linkId: link.id,
    };
    edges.push(edge);
    na.edgeIds.push(edge.id);
    nb.edgeIds.push(edge.id);
  }

  return { layer, nodes, edges };
}

/** Snaps a map point onto the nearest edge within `maxDistance` tiles. */
export function locateOnGraph(
  graph: NetworkGraph,
  x: number,
  y: number,
  maxDistance: number
): EdgeLocation | null {
  let best: EdgeLocation | null = null;
  for (const e of graph.edges) {
    const a = graph.nodes[e.a]!;
    const b = graph.nodes[e.b]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / len2));
    const px = a.x + vx * t;
    const py = a.y + vy * t;
    const d = Math.hypot(x - px, y - py);
    if (d <= maxDistance && (!best || d < best.distance)) {
      best = { edgeId: e.id, t, x: px, y: py, distance: d };
    }
  }
  return best;
}

/** Nearest location to a rectangle footprint (buildings & zones touch the road at their edge). */
export function locateRectOnGraph(
  graph: NetworkGraph,
  rect: { x: number; y: number; width: number; depth: number },
  maxDistance: number
): EdgeLocation | null {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.depth / 2;
  const halfDiag = Math.hypot(rect.width, rect.depth) / 2;
  return locateOnGraph(graph, cx, cy, maxDistance + halfDiag);
}

export type EdgeCostFn = (edge: GraphEdge) => number;

/** Default cost: travel hours at the health-reduced speed limit, slowed by congestion. */
export function travelTimeCost(volumeCapacityByEdge?: ReadonlyMap<number, number>): EdgeCostFn {
  return (edge) => {
    const speed = Math.max(1, edge.speedLimitKmh * roadHealthSpeedFactor(edge.healthPercent));
    const km = edge.lengthTiles * 0.01;
    const vc = volumeCapacityByEdge?.get(edge.id) ?? 0;
    return (km / speed) * congestionTravelTimeFactor(vc) + (edge.delayHours ?? 0);
  };
}

class MinHeap {
  private readonly items: Array<[number, number]> = [];
  get size(): number {
    return this.items.length;
  }
  push(priority: number, value: number): void {
    const it = this.items;
    it.push([priority, value]);
    let i = it.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (it[p]![0] <= it[i]![0]) break;
      [it[p], it[i]] = [it[i]!, it[p]!];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const it = this.items;
    if (it.length === 0) return undefined;
    const top = it[0]!;
    const last = it.pop()!;
    if (it.length > 0) {
      it[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < it.length && it[l]![0] < it[m]![0]) m = l;
        if (r < it.length && it[r]![0] < it[m]![0]) m = r;
        if (m === i) break;
        [it[m], it[i]] = [it[i]!, it[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Shortest-time route between two snapped locations (A* with straight-line / max-speed heuristic).
 * Returns `null` when the two points are not connected.
 */
export function findRoute(
  graph: NetworkGraph,
  from: EdgeLocation,
  to: EdgeLocation,
  cost: EdgeCostFn = travelTimeCost()
): RouteResult | null {
  const fromEdge = graph.edges[from.edgeId]!;
  const toEdge = graph.edges[to.edgeId]!;

  // Both points on one edge: driving straight along it is the baseline the graph search must beat
  const direct: RouteResult | null =
    from.edgeId === to.edgeId
      ? {
          points: dedupePolyline([from.x, from.y, to.x, to.y]),
          lengthTiles: fromEdge.lengthTiles * Math.abs(to.t - from.t),
          travelTimeHours: cost(fromEdge) * Math.abs(to.t - from.t),
          edgeShares: [{ edgeId: from.edgeId, share: Math.abs(to.t - from.t) }],
        }
      : null;

  const maxSpeed = 110;
  const targetA = graph.nodes[toEdge.a]!;
  const targetB = graph.nodes[toEdge.b]!;
  const heuristic = (n: GraphNode) =>
    (Math.min(Math.hypot(n.x - targetA.x, n.y - targetA.y), Math.hypot(n.x - targetB.x, n.y - targetB.y)) *
      0.01) /
    maxSpeed;

  const dist = new Map<number, number>();
  const prevEdge = new Map<number, number>();
  const heap = new MinHeap();
  const seed = (nodeId: number, share: number) => {
    const g = cost(fromEdge) * share;
    if (g < (dist.get(nodeId) ?? Infinity)) {
      dist.set(nodeId, g);
      prevEdge.set(nodeId, -1);
      heap.push(g + heuristic(graph.nodes[nodeId]!), nodeId);
    }
  };
  seed(fromEdge.a, from.t);
  seed(fromEdge.b, 1 - from.t);

  // Exit costs onto the target edge from its two end nodes
  const exitCost = new Map<number, number>([
    [toEdge.a, cost(toEdge) * to.t],
    [toEdge.b, cost(toEdge) * (1 - to.t)],
  ]);

  let bestTotal = direct ? direct.travelTimeHours : Infinity;
  let bestExitNode = -1;
  const closed = new Set<number>();

  while (heap.size > 0) {
    const [, nodeId] = heap.pop()!;
    if (closed.has(nodeId)) continue;
    closed.add(nodeId);
    const g = dist.get(nodeId)!;
    if (g >= bestTotal) break;

    const exit = exitCost.get(nodeId);
    if (exit !== undefined && g + exit < bestTotal) {
      bestTotal = g + exit;
      bestExitNode = nodeId;
    }

    const node = graph.nodes[nodeId]!;
    for (const eid of node.edgeIds) {
      const e = graph.edges[eid]!;
      const next = e.a === nodeId ? e.b : e.a;
      if (closed.has(next)) continue;
      const ng = g + cost(e);
      if (ng < (dist.get(next) ?? Infinity)) {
        dist.set(next, ng);
        prevEdge.set(next, eid);
        heap.push(ng + heuristic(graph.nodes[next]!), next);
      }
    }
  }

  if (bestExitNode < 0) return direct;

  // Reconstruct node chain back to the start edge
  const chainEdges: number[] = [];
  const chainNodes: number[] = [bestExitNode];
  let cur = bestExitNode;
  while (prevEdge.get(cur)! >= 0) {
    const eid = prevEdge.get(cur)!;
    chainEdges.push(eid);
    const e = graph.edges[eid]!;
    cur = e.a === cur ? e.b : e.a;
    chainNodes.push(cur);
  }
  chainEdges.reverse();
  chainNodes.reverse();

  const startNode = chainNodes[0]!;
  const startShare = startNode === fromEdge.a ? from.t : 1 - from.t;
  const endShare = bestExitNode === toEdge.a ? to.t : 1 - to.t;

  const points: number[] = [from.x, from.y];
  for (const nid of chainNodes) {
    const n = graph.nodes[nid]!;
    points.push(n.x, n.y);
  }
  points.push(to.x, to.y);

  const edgeShares: Array<{ edgeId: number; share: number }> = [];
  if (startShare > 0) edgeShares.push({ edgeId: fromEdge.id, share: startShare });
  for (const eid of chainEdges) edgeShares.push({ edgeId: eid, share: 1 });
  if (endShare > 0) edgeShares.push({ edgeId: toEdge.id, share: endShare });

  const lengthTiles = edgeShares.reduce(
    (s, es) => s + graph.edges[es.edgeId]!.lengthTiles * es.share,
    0
  );
  return {
    points: dedupePolyline(points),
    lengthTiles,
    travelTimeHours: bestTotal,
    edgeShares,
  };
}

function dedupePolyline(points: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i]!;
    const y = points[i + 1]!;
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2]! - x) < 1e-6 && Math.abs(out[n - 1]! - y) < 1e-6) continue;
    out.push(x, y);
  }
  if (out.length === 2) out.push(out[0]!, out[1]!);
  return out;
}

/** Connected-component labels for every node (used to check bus stops & metro stations are linked). */
export function connectedComponents(graph: NetworkGraph): Int32Array {
  const label = new Int32Array(graph.nodes.length).fill(-1);
  let next = 0;
  for (const start of graph.nodes) {
    if (label[start.id] !== -1) continue;
    const stack = [start.id];
    label[start.id] = next;
    while (stack.length > 0) {
      const nid = stack.pop()!;
      for (const eid of graph.nodes[nid]!.edgeIds) {
        const e = graph.edges[eid]!;
        const other = e.a === nid ? e.b : e.a;
        if (label[other] === -1) {
          label[other] = next;
          stack.push(other);
        }
      }
    }
    next += 1;
  }
  return label;
}
