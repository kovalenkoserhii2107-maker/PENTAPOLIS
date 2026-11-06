/**
 * 1000×1000 Flat Peninsula Grid (`Z = 0`, `Z = +1` bridges/flyovers) & Hybrid 90°/45° Network
 * (`GDD Chapter 2`, Sheet 09 `Map & Growth`, Map Scheme `Pentapolis — Схема Карты Полуострова`).
 */
import type { SectorId } from "../catalogs/visuals.ts";
import { money, mulRate, type Money } from "../money/money.ts";

export const GRID_WIDTH = 1000;
export const GRID_HEIGHT = 1000;
export const TILE_METERS = 10;
export const CORE_CENTER_X = 500;
export const CORE_CENTER_Y = 500;
export const CORE_RADIUS_TILES = 60; // Diameter = 120 tiles (1.2 km), area ~ 11,310 tiles

export const enum SurfaceType {
  Sea = 0,
  Land = 1,
  River = 2,
  Mainland = 3,
}

export const enum OwnerCode {
  None = 0,
  Sector1 = 1,
  Sector2 = 2,
  Sector3 = 3,
  Sector4 = 4,
  Sector5 = 5,
  CentralCore = 6,
}

export type GridAngleMode = "ortho_90" | "diag_45";

export type NetworkKind =
  | "street_2lane"   // INF-01
  | "avenue_4lane"   // INF-02
  | "express_6lane"  // INF-03
  | "heavy_bypass"   // INF-04
  | "rail"           // INF-05
  | "pipeline"       // INF-06
  | "hv_power"       // INF-09
  | "metro_tunnel";  // TRN-08 (underground Z = -1)

export type ZoneKind =
  | "RES-01"
  | "RES-02"
  | "RES-03"
  | "COM-01"
  | "COM-02"
  | "COM-03"
  | "OFF-01"
  | "OFF-02";

export interface ResourceDepositSite {
  readonly id: string;
  readonly sectorId: SectorId;
  readonly resourceName: string;
  readonly role: "Profile" | "Secondary" | "Scarce";
  readonly tileX: number;
  readonly tileY: number;
  readonly radiusTiles: number;
  readonly offshore: boolean;
}

export interface ExternalGatewayPoint {
  readonly id: string;
  readonly sectorId: SectorId;
  readonly kind: "overland_highway" | "underground_tunnel";
  readonly tileX: number;
  readonly tileY: number;
  readonly labelRu: string;
}

export interface NetworkSegment {
  readonly id: string;
  readonly sectorId: SectorId;
  readonly kind: NetworkKind;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly angleMode: GridAngleMode;
  readonly lengthMeters: number;
  readonly riverCrossingTiles: number;
  readonly hasBridge: boolean;
  readonly isFlyover: boolean; // Z = +1
  readonly buildCostLocal: Money;
  healthPercent: number; // 0..100 (GDD §5.2: <75% potholes, <40% emergency)
}

export interface PlacedZonePatch {
  readonly id: string;
  readonly sectorId: SectorId;
  readonly zoneKind: ZoneKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly depth: number;
  readonly orientationDeg: 0 | 45 | 90 | 135;
  occupancyRatio: number; // 0..1 built by private developers
}

export interface PlacedBuildingInstance {
  readonly id: string;
  readonly catalogId: string;
  readonly sectorId: SectorId | "core";
  readonly tileX: number;
  readonly tileY: number;
  readonly width: number;
  readonly depth: number;
  readonly orientationDeg: 0 | 45 | 90 | 135;
  level: number;
  constructionProgress: number; // 0..1 (1 = operational)
  cityEquityShare: number; // 1.0 for municipal, 0.1..1.0 for Tier 2–4 plants
  stalledAwaitingPrivate: boolean;
}

export interface PeninsulaMapData {
  readonly width: number;
  readonly height: number;
  /** Row-major `idx = y * 1000 + x` surface types (`SurfaceType`). */
  readonly surface: Uint8Array;
  /** Row-major `idx = y * 1000 + x` owner codes (`OwnerCode`). */
  readonly owner: Uint8Array;
  /** Buildable land tile counts per sector (excluding rivers & sea). */
  readonly sectorLandTiles: Readonly<Record<SectorId, number>>;
  readonly centralCoreTiles: number;
  readonly gateways: readonly ExternalGatewayPoint[];
  readonly deposits: readonly ResourceDepositSite[];
}

/**
 * Normalizes `atan2(dy, dx)` into `[0, 2π)`:
 * `0` = East (+X), `π/2` = South (+Y), `π` = West (-X), `3π/2` = North (-Y).
 */
function normalizeAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  let a = rad % twoPi;
  if (a < 0) a += twoPi;
  return a;
}

/**
 * Angular sector boundaries around `(500, 500)` matching the Ring `1 ↔ 2 ↔ 5 ↔ 4 ↔ 3 ↔ 1`:
 * - S5 (East Cape):      `[342°, 36°)`
 * - S4 (South Foothills):`[36°, 108°)`
 * - S3 (SW Valley):      `[108°, 186°)`
 * - S1 (NW Basin):       `[186°, 268°)`
 * - S2 (NE Shelf):       `[268°, 342°)`
 */
export const SECTOR_BOUNDARY_DEGREES = [36, 108, 186, 268, 342] as const;

function angleToSector(deg: number): SectorId {
  if (deg >= 342 || deg < 36) return 5;
  if (deg < 108) return 4;
  if (deg < 186) return 3;
  if (deg < 268) return 1;
  return 2;
}

/**
 * Base organic coastline shape (Crimea-inspired peninsula outline with western Tarkhankut cape,
 * northern isthmus, eastern Kerch cape, and southern mountain arc), scaled per sector so each
 * sector gets ~90,000 buildable land tiles (within ±2% of 90,000, per GDD §2.1 & Sheet 09).
 */
function baseCoastShapeFactor(rad: number): number {
  return (
    1.0 +
    0.11 * Math.cos(2 * rad - 0.3) +
    0.07 * Math.sin(3 * rad + 0.8) +
    0.05 * Math.cos(5 * rad - 1.1) +
    // Capes and bays at several scales so the shore is not one smooth blob
    0.024 * Math.sin(7 * rad + 1.3) +
    0.015 * Math.sin(11 * rad + 0.4) +
    0.009 * Math.sin(17 * rad + 2.1) +
    0.005 * Math.sin(29 * rad + 0.9)
  );
}

/** Angular half-width (degrees) over which neighbouring sectors' coast radii blend into one smooth shore. */
const COAST_BLEND_DEGREES = 14;

/**
 * Coast radius at an angle. Each sector has its own scale (to equalise land area), blended with
 * the neighbour's near the shared border so the shoreline has no step at sector seams.
 */
function coastRadius(rad: number, deg: number, scales: Readonly<Record<SectorId, number>>): number {
  let scale = scales[angleToSector(deg)];
  for (const b of SECTOR_BOUNDARY_DEGREES) {
    let d = deg - b;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    if (Math.abs(d) >= COAST_BLEND_DEGREES) continue;
    const before = scales[angleToSector((b - 1 + 360) % 360)];
    const after = scales[angleToSector(b + 1)];
    const t = (d / COAST_BLEND_DEGREES + 1) / 2;
    const w = t * t * (3 - 2 * t);
    scale = before * (1 - w) + after * w;
    break;
  }
  return scale * baseCoastShapeFactor(rad);
}

/**
 * Half-width of a northern isthmus: a narrow neck that flares smoothly where it meets the
 * mainland (`y = 34`) and where it joins the peninsula (`joinY`).
 */
function isthmusHalfWidth(y: number, joinY: number): number {
  const top = Math.exp(-(((y - 34) / 24) ** 2));
  const bottom = Math.exp(-(((joinY - y) / 30) ** 2));
  return 18 + 16 * top + 22 * bottom + 1.5 * Math.sin(y * 0.05);
}

/** Gentle sideways drift of an isthmus centre line so its shores are not parallel straight lines. */
function isthmusDrift(y: number, phase: number): number {
  const t = Math.min(1, Math.max(0, (y - 34) / 206));
  return Math.sin(t * Math.PI) * 4 * Math.sin(y * 0.018 + phase);
}

/** First row (from the north) where the peninsula body reaches column `x`. */
function peninsulaTopY(x: number, scales: Readonly<Record<SectorId, number>>): number {
  for (let y = 36; y < CORE_CENTER_Y; y++) {
    const dx = x - CORE_CENTER_X;
    const dy = y - CORE_CENTER_Y;
    const rad = normalizeAngle(Math.atan2(dy, dx));
    if (Math.hypot(dx, dy) <= coastRadius(rad, (rad * 180) / Math.PI, scales)) return y;
  }
  return 240;
}

/** Centripetal-free uniform Catmull-Rom through control points, sampled about every half tile. */
function smoothPolyline(pts: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    const steps = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) * 2));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push([pts[pts.length - 1]![0], pts[pts.length - 1]![1]]);
  return out;
}

/** Adds natural meanders: a sideways sine sway (two wavelengths), fading to zero at both ends. */
function meander(path: readonly [number, number][], seed: number): [number, number][] {
  const lengths = [0];
  for (let i = 1; i < path.length; i++) {
    lengths.push(lengths[i - 1]! + Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]));
  }
  const total = lengths[lengths.length - 1]!;
  return path.map(([x, y], i) => {
    const a = path[Math.max(0, i - 2)]!;
    const b = path[Math.min(path.length - 1, i + 2)]!;
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1;
    const s = lengths[i]!;
    const fade = Math.min(1, s / 25, (total - s) / 25);
    const sway = (Math.sin(s / 7.5 + seed) * 4.2 + Math.sin(s / 2.9 + seed * 2.3) * 1.3) * fade;
    return [x + (-ty / len) * sway, y + (tx / len) * sway];
  });
}

/** Southern shore of the decorative northern mainland (the continent the isthmuses join). */
export function mainlandEdgeY(x: number): number {
  return 26 + 6 * Math.sin(x * 0.017 + 0.4) + 3 * Math.sin(x * 0.043 + 1.3);
}

let cachedPeninsulaMap: PeninsulaMapData | null = null;

export function generatePeninsulaMap(): PeninsulaMapData {
  if (cachedPeninsulaMap) return cachedPeninsulaMap;

  const totalCells = GRID_WIDTH * GRID_HEIGHT;
  const surface = new Uint8Array(totalCells);
  const owner = new Uint8Array(totalCells);

  // Calibrate per-sector radial scale in 4 fast subgrid iterations so every sector's
  // buildable land area (including S1/S2 northern isthmus strips) lands right at ~90,000 tiles.
  const sectorScales: Record<SectorId, number> = {
    1: 266,
    2: 282,
    3: 276,
    4: 294,
    5: 342,
  };

  for (let iter = 0; iter < 5; iter++) {
    const join1 = Math.min(240, peninsulaTopY(425, sectorScales));
    const join2 = Math.min(240, peninsulaTopY(560, sectorScales));
    const counts: Record<SectorId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const step = iter < 3 ? 4 : 2;
    const weight = step * step;
    for (let y = 34; y < GRID_HEIGHT - 12; y += step) {
      const dy = y - CORE_CENTER_Y;
      for (let x = 12; x < GRID_WIDTH - 12; x += step) {
        if (y <= join1 && Math.abs(x - 425 - isthmusDrift(y, 0.7)) <= isthmusHalfWidth(y, join1)) {
          counts[1] += weight;
          continue;
        }
        if (y <= join2 && Math.abs(x - 560 - isthmusDrift(y, 2.9)) <= isthmusHalfWidth(y, join2)) {
          counts[2] += weight;
          continue;
        }
        if (y < 36) continue;
        const dx = x - CORE_CENTER_X;
        const distSq = dx * dx + dy * dy;
        if (distSq <= CORE_RADIUS_TILES * CORE_RADIUS_TILES) continue;
        const dist = Math.sqrt(distSq);
        const rad = normalizeAngle(Math.atan2(dy, dx));
        const deg = (rad * 180) / Math.PI;
        const sec = angleToSector(deg);
        const maxR = coastRadius(rad, deg, sectorScales);
        if (dist <= maxR) {
          counts[sec] += weight;
        }
      }
    }
    const targetWithRiverAllowance = 91_200; // ~1,200 tiles carved out for river loops -> ~90,000 net land
    for (const s of [1, 2, 3, 4, 5] as const) {
      const ratio = Math.sqrt(targetWithRiverAllowance / Math.max(1, counts[s]));
      sectorScales[s] = Math.min(460, Math.max(180, sectorScales[s] * (0.25 + 0.75 * ratio)));
    }
  }

  // Paint northern Mainland strip (`y < 36` around northern isthmus `x in 310..670`) + Peninsula Land + Core
  for (let y = 0; y < GRID_HEIGHT; y++) {
    const dy = y - CORE_CENTER_Y;
    const rowOff = y * GRID_WIDTH;
    for (let x = 0; x < GRID_WIDTH; x++) {
      const idx = rowOff + x;
      if (y < mainlandEdgeY(x)) {
        surface[idx] = SurfaceType.Mainland;
        owner[idx] = OwnerCode.None;
        continue;
      }
      if (y < 36 || y >= GRID_HEIGHT - 12 || x < 12 || x >= GRID_WIDTH - 12) {
        continue;
      }
      const dx = x - CORE_CENTER_X;
      const distSq = dx * dx + dy * dy;
      if (distSq <= CORE_RADIUS_TILES * CORE_RADIUS_TILES) {
        surface[idx] = SurfaceType.Land;
        owner[idx] = OwnerCode.CentralCore;
        continue;
      }
      const dist = Math.sqrt(distSq);
      const rad = normalizeAngle(Math.atan2(dy, dx));
      const deg = (rad * 180) / Math.PI;
      const sec = angleToSector(deg);
      const maxR = coastRadius(rad, deg, sectorScales);
      if (dist <= maxR) {
        surface[idx] = SurfaceType.Land;
        owner[idx] = sec as OwnerCode;
      }
    }
  }

  // Northern overland isthmus bridges connecting S1 (`x=420`) and S2 (`x=565`) to Mainland (`y=34..220`)
  for (const [isthmusX, sec, phase] of [
    [425, OwnerCode.Sector1, 0.7],
    [560, OwnerCode.Sector2, 2.9],
  ] as const) {
    const joinY = Math.min(240, peninsulaTopY(isthmusX, sectorScales));
    for (let y = 34; y <= joinY + 30; y++) {
      const hw = isthmusHalfWidth(y, joinY);
      const cx = isthmusX + isthmusDrift(y, phase);
      for (let x = Math.ceil(cx - hw); x <= Math.floor(cx + hw); x++) {
        const idx = y * GRID_WIDTH + x;
        if (owner[idx] === OwnerCode.None) {
          surface[idx] = SurfaceType.Land;
          owner[idx] = sec;
        }
      }
    }
  }

  // Carve the 5 canonical freshwater river systems (4 river loops in S1..S4 + 1 through-channel in S5)
  let riverSeed = 0;
  const carveRiverPolyline = (pts: readonly [number, number][], sourceHalfWidth = 1.6, mouthHalfWidth = 2.9) => {
    const path = meander(smoothPolyline(pts), (riverSeed += 1.7));
    for (let i = 0; i < path.length; i++) {
      const [cx, cy] = path[i]!;
      const hw = sourceHalfWidth + (mouthHalfWidth - sourceHalfWidth) * (i / Math.max(1, path.length - 1));
      const r = Math.ceil(hw);
      for (let ty = Math.floor(cy - r); ty <= Math.ceil(cy + r); ty++) {
        for (let tx = Math.floor(cx - r); tx <= Math.ceil(cx + r); tx++) {
          if (tx < 0 || tx >= GRID_WIDTH || ty < 0 || ty >= GRID_HEIGHT) continue;
          if (Math.hypot(tx + 0.5 - (cx + 0.5), ty + 0.5 - (cy + 0.5)) > hw) continue;
          const idx = ty * GRID_WIDTH + tx;
          if (surface[idx] === SurfaceType.Land && owner[idx] !== OwnerCode.CentralCore) {
            surface[idx] = SurfaceType.River;
          }
        }
      }
    }
  };

  // S1 NW river loop (matches blue loop in Sector 1 on scheme)
  carveRiverPolyline([
    [255, 295],
    [345, 315],
    [390, 355],
    [375, 405],
    [280, 385],
    [225, 395],
  ]);
  // S2 NE river loop
  carveRiverPolyline([
    [665, 255],
    [610, 315],
    [605, 375],
    [660, 405],
    [735, 420],
  ]);
  // S3 SW river loop
  carveRiverPolyline([
    [300, 565],
    [360, 540],
    [395, 585],
    [370, 650],
    [295, 675],
  ]);
  // S4 South river loop (mountain hydro catchment)
  carveRiverPolyline([
    [485, 765],
    [475, 665],
    [515, 620],
    [575, 660],
    [625, 725],
  ]);
  // S5 East Cape through-flowing river channel
  carveRiverPolyline([
    [735, 455],
    [760, 505],
    [790, 565],
    [815, 610],
  ]);

  // Count net buildable land tiles per sector
  const sectorLandTiles: Record<SectorId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let centralCoreTiles = 0;
  for (let i = 0; i < totalCells; i++) {
    if (surface[i] !== SurfaceType.Land) continue;
    const ow = owner[i]!;
    if (ow >= 1 && ow <= 5) {
      sectorLandTiles[ow as SectorId] += 1;
    } else if (ow === OwnerCode.CentralCore) {
      centralCoreTiles += 1;
    }
  }

  // Starter External World Gateways (GDD §2.2 & Sheet 09 Section 2)
  const gateways: ExternalGatewayPoint[] = [
    {
      id: "GW-S1",
      sectorId: 1,
      kind: "overland_highway",
      tileX: 425,
      tileY: 38,
      labelRu: "Северное шоссе №1 (2 полосы, Внешний мир)",
    },
    {
      id: "GW-S2",
      sectorId: 2,
      kind: "overland_highway",
      tileX: 560,
      tileY: 38,
      labelRu: "Северное шоссе №2 (2 полосы, Внешний мир)",
    },
    {
      id: "GW-S3",
      sectorId: 3,
      kind: "underground_tunnel",
      tileX: 412,
      tileY: 545,
      labelRu: "Рампа Подземного туннеля №1 (2 полосы, Внешний мир)",
    },
    {
      id: "GW-S4",
      sectorId: 4,
      kind: "underground_tunnel",
      tileX: 505,
      tileY: 590,
      labelRu: "Рампа Подземного туннеля №2 (2 полосы, Внешний мир)",
    },
    {
      id: "GW-S5",
      sectorId: 5,
      kind: "underground_tunnel",
      tileX: 592,
      tileY: 515,
      labelRu: "Рампа Подземного туннеля №3 (2 полосы, Внешний мир)",
    },
  ];

  // Canonical Resource Deposits (GDD §2.3 & Sheet 18 Table 2)
  const deposits: ResourceDepositSite[] = [
    // Sector 1: Profile Iron Ore & Coal + Secondary Stone & Timber + Scarce Gas & Oil
    { id: "DEP-S1-IRON", sectorId: 1, resourceName: "Iron Ore", role: "Profile", tileX: 355, tileY: 265, radiusTiles: 16, offshore: false },
    { id: "DEP-S1-COAL", sectorId: 1, resourceName: "Coal", role: "Profile", tileX: 410, tileY: 310, radiusTiles: 15, offshore: false },
    { id: "DEP-S1-STONE", sectorId: 1, resourceName: "Limestone & Granite", role: "Secondary", tileX: 315, tileY: 350, radiusTiles: 9, offshore: false },
    { id: "DEP-S1-TIMBER", sectorId: 1, resourceName: "Timber", role: "Secondary", tileX: 365, tileY: 430, radiusTiles: 9, offshore: false },
    { id: "DEP-S1-GAS", sectorId: 1, resourceName: "Natural Gas", role: "Scarce", tileX: 290, tileY: 270, radiusTiles: 6, offshore: false },

    // Sector 2: Profile Crude Oil & Natural Gas + Secondary Stone + Scarce Timber & Iron
    { id: "DEP-S2-OIL", sectorId: 2, resourceName: "Crude Oil", role: "Profile", tileX: 735, tileY: 245, radiusTiles: 16, offshore: true },
    { id: "DEP-S2-GAS", sectorId: 2, resourceName: "Natural Gas", role: "Profile", tileX: 695, tileY: 310, radiusTiles: 16, offshore: false },
    { id: "DEP-S2-STONE", sectorId: 2, resourceName: "Limestone & Granite", role: "Secondary", tileX: 585, tileY: 280, radiusTiles: 9, offshore: false },
    { id: "DEP-S2-TIMBER", sectorId: 2, resourceName: "Timber", role: "Scarce", tileX: 560, tileY: 365, radiusTiles: 6, offshore: false },
    { id: "DEP-S2-COAL", sectorId: 2, resourceName: "Coal", role: "Scarce", tileX: 640, tileY: 360, radiusTiles: 6, offshore: false },

    // Sector 3: Profile Grain & Timber + Secondary Stone + Scarce Gas & Coal
    { id: "DEP-S3-GRAIN", sectorId: 3, resourceName: "Grain", role: "Profile", tileX: 335, tileY: 595, radiusTiles: 18, offshore: false },
    { id: "DEP-S3-TIMBER", sectorId: 3, resourceName: "Timber", role: "Profile", tileX: 285, tileY: 515, radiusTiles: 16, offshore: false },
    { id: "DEP-S3-STONE", sectorId: 3, resourceName: "Limestone & Granite", role: "Secondary", tileX: 395, tileY: 635, radiusTiles: 9, offshore: false },
    { id: "DEP-S3-GAS", sectorId: 3, resourceName: "Natural Gas", role: "Scarce", tileX: 265, tileY: 615, radiusTiles: 6, offshore: false },
    { id: "DEP-S3-IRON", sectorId: 3, resourceName: "Iron Ore", role: "Scarce", tileX: 350, tileY: 495, radiusTiles: 6, offshore: false },

    // Sector 4: Profile Limestone & Granite + Secondary Timber & Coal + Scarce Gas & Oil
    { id: "DEP-S4-STONE", sectorId: 4, resourceName: "Limestone & Granite", role: "Profile", tileX: 535, tileY: 690, radiusTiles: 18, offshore: false },
    { id: "DEP-S4-TIMBER", sectorId: 4, resourceName: "Timber", role: "Secondary", tileX: 455, tileY: 675, radiusTiles: 10, offshore: false },
    { id: "DEP-S4-COAL", sectorId: 4, resourceName: "Coal", role: "Secondary", tileX: 585, tileY: 635, radiusTiles: 9, offshore: false },
    { id: "DEP-S4-GAS", sectorId: 4, resourceName: "Natural Gas", role: "Scarce", tileX: 495, tileY: 735, radiusTiles: 6, offshore: false },
    { id: "DEP-S4-OIL", sectorId: 4, resourceName: "Crude Oil", role: "Scarce", tileX: 610, tileY: 700, radiusTiles: 6, offshore: false },

    // Sector 5: Profile Quartz & Silica Sand + Secondary Gas & Stone + Scarce Timber & Oil
    { id: "DEP-S5-QUARTZ", sectorId: 5, resourceName: "Quartz & Silica Sand", role: "Profile", tileX: 775, tileY: 485, radiusTiles: 16, offshore: false },
    { id: "DEP-S5-GAS", sectorId: 5, resourceName: "Natural Gas", role: "Secondary", tileX: 695, tileY: 470, radiusTiles: 10, offshore: false },
    { id: "DEP-S5-STONE", sectorId: 5, resourceName: "Limestone & Granite", role: "Secondary", tileX: 675, tileY: 545, radiusTiles: 9, offshore: false },
    { id: "DEP-S5-TIMBER", sectorId: 5, resourceName: "Timber", role: "Scarce", tileX: 635, tileY: 490, radiusTiles: 6, offshore: false },
    { id: "DEP-S5-OIL", sectorId: 5, resourceName: "Crude Oil", role: "Scarce", tileX: 835, tileY: 530, radiusTiles: 7, offshore: true },
  ];

  cachedPeninsulaMap = {
    width: GRID_WIDTH,
    height: GRID_HEIGHT,
    surface,
    owner,
    sectorLandTiles,
    centralCoreTiles,
    gateways,
    deposits,
  };
  return cachedPeninsulaMap;
}

const NETWORK_COST_PER_KM_UNITS: Readonly<Record<NetworkKind, number>> = {
  street_2lane: 180_000,
  avenue_4lane: 420_000,
  express_6lane: 950_000,
  heavy_bypass: 1_350_000,
  rail: 180_000,
  pipeline: 450_000,
  hv_power: 120_000,
  metro_tunnel: 60_000_000,
};

/**
 * Validates and quotes a 90° orthogonal or 45° diagonal transport/utility segment
 * on the 1000×1000 peninsula grid (`GDD §2.1, §5.2`: bridges over rivers cost 3x).
 */
export function validateAndQuoteNetworkSegment(params: {
  map: PeninsulaMapData;
  sectorId: SectorId;
  kind: NetworkKind;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  isFlyover?: boolean;
  fxRatePerWcu?: number;
}): { ok: true; preview: Omit<NetworkSegment, "id"> } | { ok: false; reason: string } {
  const { map, sectorId, kind, fromX, fromY, toX, toY } = params;
  const fx = params.fxRatePerWcu ?? 1.0;

  if (
    fromX < 0 ||
    fromX >= map.width ||
    toX < 0 ||
    toX >= map.width ||
    fromY < 0 ||
    fromY >= map.height ||
    toY < 0 ||
    toY >= map.height
  ) {
    return { ok: false, reason: "Координаты выходят за пределы карты 1000×1000" };
  }

  const dx = toX - fromX;
  const dy = toY - fromY;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx === 0 && ady === 0) {
    return { ok: false, reason: "Нулевая длина сегмента" };
  }

  // Strictly 90° orthogonal or 45° diagonal (GDD §2.1)
  let angleMode: GridAngleMode;
  if (adx === 0 || ady === 0) {
    angleMode = "ortho_90";
  } else if (adx === ady) {
    angleMode = "diag_45";
  } else {
    return {
      ok: false,
      reason: "Сетка поддерживает только углы 0°/90° и диагонали 45° (|Δx| = |Δy|)",
    };
  }

  const steps = Math.max(adx, ady);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  let riverCrossingTiles = 0;

  for (let s = 0; s <= steps; s++) {
    const x = fromX + sx * s;
    const y = fromY + sy * s;
    const idx = y * map.width + x;
    const surf = map.surface[idx]!;
    const ow = map.owner[idx]!;

    // Allow building inside own sector OR connecting into Central Core neutral zone
    if (ow !== (sectorId as OwnerCode) && ow !== OwnerCode.CentralCore) {
      return {
        ok: false,
        reason: `Тайл (${x}, ${y}) принадлежит другому сектору или акватории`,
      };
    }
    if (surf === SurfaceType.Sea && kind !== "pipeline") {
      return { ok: false, reason: `Нельзя строить ${kind} по открытому морю` };
    }
    if (surf === SurfaceType.River) {
      riverCrossingTiles += 1;
    }
  }

  const stepMeters = angleMode === "diag_45" ? TILE_METERS * Math.SQRT2 : TILE_METERS;
  const lengthMeters = steps * stepMeters;
  const riverMeters = riverCrossingTiles * stepMeters;
  const landMeters = Math.max(0, lengthMeters - riverMeters);

  const basePerKm = NETWORK_COST_PER_KM_UNITS[kind];
  const isFlyover = Boolean(params.isFlyover);
  const flyoverMult = isFlyover ? 2.2 : 1.0;

  // River bridge tiles cost 3x the road/rail cost (GDD §5.2)
  const costWcuUnits =
    ((landMeters / 1000) * basePerKm * flyoverMult +
      (riverMeters / 1000) * basePerKm * 3.0);
  const buildCostLocal = mulRate(money(costWcuUnits), fx);

  return {
    ok: true,
    preview: {
      sectorId,
      kind,
      fromX,
      fromY,
      toX,
      toY,
      angleMode,
      lengthMeters,
      riverCrossingTiles,
      hasBridge: riverCrossingTiles > 0 && kind !== "metro_tunnel",
      isFlyover,
      buildCostLocal,
      healthPercent: 100,
    },
  };
}

/**
 * Snaps an arbitrary cursor target `(rawToX, rawToY)` from `(fromX, fromY)` onto the nearest
 * valid 8-directional (`0°/90°` or `45°`) ray so road/rail dragging feels crisp and effortless.
 */
export function snapToHybridGrid45(
  fromX: number,
  fromY: number,
  rawToX: number,
  rawToY: number
): { toX: number; toY: number; angleMode: GridAngleMode } {
  const dx = rawToX - fromX;
  const dy = rawToY - fromY;
  if (dx === 0 && dy === 0) {
    return { toX: fromX, toY: fromY, angleMode: "ortho_90" };
  }
  const angle = Math.atan2(dy, dx);
  const octant = Math.round(angle / (Math.PI / 4));
  const dist = Math.round(Math.hypot(dx, dy));
  const dirs: Record<number, [number, number, GridAngleMode]> = {
    0: [1, 0, "ortho_90"],
    1: [1, 1, "diag_45"],
    2: [0, 1, "ortho_90"],
    3: [-1, 1, "diag_45"],
    4: [-1, 0, "ortho_90"],
    [-4]: [-1, 0, "ortho_90"],
    [-3]: [-1, -1, "diag_45"],
    [-2]: [0, -1, "ortho_90"],
    [-1]: [1, -1, "diag_45"],
  };
  const [ux, uy, mode] = dirs[octant] ?? [1, 0, "ortho_90"];
  const steps = mode === "diag_45" ? Math.max(1, Math.round(dist / Math.SQRT2)) : Math.max(1, dist);
  return {
    toX: Math.max(0, Math.min(GRID_WIDTH - 1, fromX + ux * steps)),
    toY: Math.max(0, Math.min(GRID_HEIGHT - 1, fromY + uy * steps)),
    angleMode: mode,
  };
}
