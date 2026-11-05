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
    0.05 * Math.cos(5 * rad - 1.1)
  );
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
    const counts: Record<SectorId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const step = iter < 3 ? 4 : 2;
    const weight = step * step;
    for (let y = 34; y < GRID_HEIGHT - 12; y += step) {
      const dy = y - CORE_CENTER_Y;
      for (let x = 12; x < GRID_WIDTH - 12; x += step) {
        if (y <= 240 && x >= 401 && x <= 449) {
          counts[1] += weight;
          continue;
        }
        if (y <= 240 && x >= 536 && x <= 584) {
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
        const maxR = sectorScales[sec] * baseCoastShapeFactor(rad);
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
      if (y < 34 && x >= 290 && x <= 690) {
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
      const maxR = sectorScales[sec] * baseCoastShapeFactor(rad);
      if (dist <= maxR) {
        surface[idx] = SurfaceType.Land;
        owner[idx] = sec as OwnerCode;
      }
    }
  }

  // Northern overland isthmus bridges connecting S1 (`x=420`) and S2 (`x=565`) to Mainland (`y=34..220`)
  for (const [isthmusX, sec] of [
    [425, OwnerCode.Sector1],
    [560, OwnerCode.Sector2],
  ] as const) {
    for (let y = 34; y <= 240; y++) {
      for (let x = isthmusX - 24; x <= isthmusX + 24; x++) {
        const idx = y * GRID_WIDTH + x;
        if (owner[idx] === OwnerCode.None) {
          surface[idx] = SurfaceType.Land;
          owner[idx] = sec;
        }
      }
    }
  }

  // Carve the 5 canonical freshwater river systems (4 river loops in S1..S4 + 1 through-channel in S5)
  const carveRiverPolyline = (pts: readonly [number, number][], halfWidth = 2) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i]!;
      const [x1, y1] = pts[i + 1]!;
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let s = 0; s <= steps; s++) {
        const cx = Math.round(x0 + ((x1 - x0) * s) / steps);
        const cy = Math.round(y0 + ((y1 - y0) * s) / steps);
        for (let oy = -halfWidth; oy <= halfWidth; oy++) {
          for (let ox = -halfWidth; ox <= halfWidth; ox++) {
            const tx = cx + ox;
            const ty = cy + oy;
            if (tx < 0 || tx >= GRID_WIDTH || ty < 0 || ty >= GRID_HEIGHT) continue;
            const idx = ty * GRID_WIDTH + tx;
            if (
              surface[idx] === SurfaceType.Land &&
              owner[idx] !== OwnerCode.CentralCore
            ) {
              surface[idx] = SurfaceType.River;
            }
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
