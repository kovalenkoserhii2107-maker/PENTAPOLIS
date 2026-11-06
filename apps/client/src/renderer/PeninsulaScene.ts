/**
 * Crisp 2:1 Orthographic Isometric Peninsula Renderer (`PeninsulaScene.ts`).
 *
 * Renders the 1000×1000 flat peninsula (`Z = 0`, `Z = +1` bridges/flyovers) with:
 * - Zero fog of war across all 5 sovereign sectors + Central Core `(500, 500)`;
 * - Pixel-crisp `DataTexture` terrain (`NearestFilter` magnification) with sector borders & rivers;
 * - 5 External World Gateway portals + 25 color-coded Resource Deposit beacons;
 * - Active Urban Emergency columns;
 * - Smooth pan (`Right/Middle Drag` or `WASD` / Arrows), zoom (`Mouse Wheel`), raycast picking,
 *   and live 90°/45° network & building footprint preview;
 * - Sprint 5: live instanced traffic (click a vehicle to inspect it), licensed bus route overlay,
 *   Underground Overlay for metro, and the bus-route / road-repair tools.
 */
import * as THREE from "three";
import {
  CORE_CENTER_X,
  CORE_CENTER_Y,
  GRID_HEIGHT,
  GRID_WIDTH,
  OwnerCode,
  SurfaceType,
  snapToHybridGrid45,
  type ActiveEmergencyDto,
  type BusRouteStatusDto,
  type ExternalGatewayPoint,
  type MasterCatalogs,
  type NetworkKind,
  type ResourceDepositSite,
  type SectorId,
  type TrafficStateDto,
  type WorldSnapshotDto,
  type ZoneKind,
} from "@pentapolis/shared-sim";
import { RoadMeshBuilder } from "./RoadMeshBuilder.ts";
import { LotGenerator, type HeatmapOverlayKind } from "./LotGenerator.ts";
import { TrafficRenderer } from "./TrafficRenderer.ts";

const MAX_FOLIAGE_TREES = 20_000;
const FOLIAGE_GREEN_HEX = [0x15803d, 0x16a34a, 0x22c55e, 0x4d7c0f] as const;
const FOLIAGE_AUTUMN_HEX = [0xdc2626, 0xea580c, 0xd97706] as const;

function tileHash(x: number, y: number, salt = 0): number {
  let h = (Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(salt, 1442695041)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function forestClusterNoise(x: number, y: number): number {
  const gx = Math.floor(x / 18);
  const gy = Math.floor(y / 18);
  const fx = (x % 18) / 18;
  const fy = (y % 18) / 18;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const n00 = (tileHash(gx, gy, 11) & 1023) / 1023;
  const n10 = (tileHash(gx + 1, gy, 11) & 1023) / 1023;
  const n01 = (tileHash(gx, gy + 1, 11) & 1023) / 1023;
  const n11 = (tileHash(gx + 1, gy + 1, 11) & 1023) / 1023;
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}

export type ActiveToolState =
  | { mode: "inspect" }
  | { mode: "network"; kind: NetworkKind; isFlyover: boolean }
  | { mode: "zone"; zoneKind: ZoneKind; brushSize: number }
  | { mode: "building"; catalogId: string; width: number; depth: number; orientationDeg: 0 | 45 | 90 | 135 }
  | { mode: "bus_route"; stopIds: readonly string[] }
  | { mode: "repair" }
  | { mode: "demolish" };

export interface HoveredTileInfo {
  readonly tileX: number;
  readonly tileY: number;
  readonly owner: number;
  readonly surface: number;
}

export interface PeninsulaSceneCallbacks {
  onHoverTile?: (info: HoveredTileInfo | null) => void;
  onSelectBuilding?: (buildingId: string | null) => void;
  onBuildSegment?: (fromX: number, fromY: number, toX: number, toY: number, kind: NetworkKind, isFlyover: boolean) => void;
  onPaintZone?: (x: number, y: number, width: number, depth: number, zoneKind: ZoneKind) => void;
  onPlaceBuilding?: (tileX: number, tileY: number, catalogId: string, orientationDeg: 0 | 45 | 90 | 135) => void;
  onSelectVehicle?: (vehicleId: string | null) => void;
  onToggleBusStop?: (buildingId: string) => void;
  onRepairSegment?: (segmentId: string) => void;
  onDemolishBuilding?: (buildingId: string) => void;
  onDemolishZone?: (zoneId: string) => void;
}

const ROUTE_COLORS = [0xdc2626, 0x2563eb, 0x16a34a, 0x9333ea, 0xea580c];

const SECTOR_LAND_RGB: Readonly<Record<number, readonly [number, number, number]>> = {
  [OwnerCode.Sector1]: [88, 132, 92],   // S1 NW Industrial Basin (temperate olive-green)
  [OwnerCode.Sector2]: [106, 142, 98],  // S2 NE Oil & Gas Shelf (coastal sage)
  [OwnerCode.Sector3]: [118, 156, 84],  // S3 Central Valley (fertile meadow green)
  [OwnerCode.Sector4]: [114, 136, 102], // S4 South Foothills (limestone highland green)
  [OwnerCode.Sector5]: [98, 146, 112],  // S5 East Cape (emerald maritime)
  [OwnerCode.CentralCore]: [148, 144, 118], // Neutral Central Core plateau
};

const SECTOR_FOCUS_TILES: Readonly<Record<SectorId | "core", readonly [number, number]>> = {
  1: [365, 310],
  2: [635, 315],
  3: [345, 575],
  4: [525, 670],
  5: [715, 495],
  core: [CORE_CENTER_X, CORE_CENTER_Y],
};

export class PeninsulaScene {
  private readonly container: HTMLElement;
  private readonly callbacks: PeninsulaSceneCallbacks;
  private readonly catalogs: MasterCatalogs;

  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly renderer: THREE.WebGLRenderer;

  private readonly roadBuilder = new RoadMeshBuilder();
  private readonly lotGenerator = new LotGenerator();
  private readonly foliageGroup = new THREE.Group();
  private foliageTrunks: THREE.InstancedMesh | null = null;
  private foliageCrowns: THREE.InstancedMesh | null = null;
  private lastFoliageSignature = "";
  private depositsCache: readonly ResourceDepositSite[] = [];
  private readonly markersGroup = new THREE.Group();
  private readonly emergenciesGroup = new THREE.Group();
  private readonly overlayRingsGroup = new THREE.Group();
  private readonly previewGroup = new THREE.Group();
  private readonly trafficRenderer = new TrafficRenderer();
  private readonly busRoutesGroup = new THREE.Group();
  private undergroundView = false;
  private followVehicleId: string | null = null;
  private heatmapOverlay: HeatmapOverlayKind = "none";

  private surfaceBytes: Uint8Array | null = null;
  private ownerBytes: Uint8Array | null = null;
  private terrainMesh: THREE.Mesh | null = null;

  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();

  private target = new THREE.Vector3(500, 0, 500);
  private frustumHalfHeight = 360;
  private zoomLevel = 1.15;

  private tool: ActiveToolState = { mode: "inspect" };
  private selectedBuildingId: string | null = null;
  private lastSnapshot: WorldSnapshotDto | null = null;

  private isPanning = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private dragStartTile: { x: number; y: number } | null = null;
  private currentHoverTile: HoveredTileInfo | null = null;
  private readonly keysPressed = new Set<string>();

  private rafId = 0;
  private readonly clock = new THREE.Clock();

  constructor(
    container: HTMLElement,
    catalogs: MasterCatalogs,
    callbacks: PeninsulaSceneCallbacks
  ) {
    this.container = container;
    this.catalogs = catalogs;
    this.callbacks = callbacks;

    this.scene.background = new THREE.Color(0x071426);

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    const aspect = w / h;
    this.camera = new THREE.OrthographicCamera(
      -this.frustumHalfHeight * aspect,
      this.frustumHalfHeight * aspect,
      this.frustumHalfHeight,
      -this.frustumHalfHeight,
      -2500,
      4500
    );

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // Crisp sun + hemisphere bounce lighting (TheoTown daylight clarity)
    const hemi = new THREE.HemisphereLight(0xe0f2fe, 0x1e293b, 0.85);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfffbeb, 1.15);
    sun.position.set(220, 620, 180);
    sun.target.position.set(500, 0, 500);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -550;
    sun.shadow.camera.right = 550;
    sun.shadow.camera.top = 550;
    sun.shadow.camera.bottom = -550;
    sun.shadow.camera.near = 50;
    sun.shadow.camera.far = 1500;
    this.scene.add(sun);
    this.scene.add(sun.target);

    this.scene.add(this.markersGroup);
    this.scene.add(this.foliageGroup);
    this.scene.add(this.roadBuilder.group);
    this.scene.add(this.lotGenerator.group);
    this.scene.add(this.overlayRingsGroup);
    this.scene.add(this.emergenciesGroup);
    this.scene.add(this.trafficRenderer.group);
    this.scene.add(this.busRoutesGroup);
    this.scene.add(this.previewGroup);

    this.updateCameraTransform();
    this.bindEvents();
    this.animate();
  }

  public setTool(tool: ActiveToolState): void {
    this.tool = tool;
    this.dragStartTile = null;
    this.rebuildPreview();
  }

  public setSelectedBuilding(buildingId: string | null): void {
    this.selectedBuildingId = buildingId;
    if (this.lastSnapshot) {
      this.lotGenerator.rebuild(
        this.lastSnapshot.buildings,
        this.lastSnapshot.zones,
        this.catalogs,
        this.selectedBuildingId,
        new Map(this.lastSnapshot.zoneSites.map((z) => [z.zoneId, z])),
        new Map(this.lastSnapshot.districts.map((d) => [d.zoneId, d])),
        this.heatmapOverlay
      );
    }
  }

  public focusSector(sectorId: SectorId | "core", zoom = 3.4): void {
    const [tx, tz] = SECTOR_FOCUS_TILES[sectorId];
    this.target.set(tx, 0, tz);
    this.zoomLevel = zoom;
    this.updateCameraTransform();
  }

  public focusTile(tileX: number, tileY: number, zoom = 6): void {
    this.followVehicleId = null;
    this.target.set(tileX, 0, tileY);
    this.zoomLevel = zoom;
    this.updateCameraTransform();
  }

  /** Land value overlay: zones tinted by district tier (sheet 25 Table 5). */
  public setLandValueOverlay(on: boolean): void {
    this.setHeatmapOverlay(on ? "land_value" : "none");
  }

  /** Switches heatmap overlay (`none` | `land_value` | `pollution` | `coverage`). */
  public setHeatmapOverlay(overlay: HeatmapOverlayKind): void {
    this.heatmapOverlay = overlay;
    this.setSelectedBuilding(this.selectedBuildingId);
    this.rebuildOverlayRings();
  }

  private rebuildOverlayRings(): void {
    while (this.overlayRingsGroup.children.length > 0) {
      const child = this.overlayRingsGroup.children.pop()! as THREE.Mesh;
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
    const snap = this.lastSnapshot;
    if (!snap || (this.heatmapOverlay !== "pollution" && this.heatmapOverlay !== "coverage")) return;

    for (const b of snap.buildings) {
      if (b.stalledAwaitingPrivate || b.constructionProgress < 0.5) continue;
      const cat = this.catalogs.buildingsById.get(b.catalogId);
      if (!cat) continue;
      const cx = b.tileX + b.width * 0.5;
      const cz = b.tileY + b.depth * 0.5;

      if (this.heatmapOverlay === "pollution") {
        const heavy =
          cat.pollution >= 2 ||
          cat.prefix === "EXT" ||
          cat.id === "ENG-01" ||
          cat.id === "UTL-04" ||
          cat.id === "UTL-05";
        const medium = cat.pollution >= 1 || cat.prefix === "PRO";
        if (!heavy && !medium) continue;
        const radius = heavy ? 18 : 11;
        const disc = new THREE.Mesh(
          new THREE.CircleGeometry(radius, 28),
          new THREE.MeshBasicMaterial({
            color: heavy ? 0xdc2626 : 0xa855f7,
            transparent: true,
            opacity: heavy ? 0.24 : 0.16,
            depthWrite: false,
          })
        );
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(cx, 0.14, cz);
        this.overlayRingsGroup.add(disc);
      } else if (this.heatmapOverlay === "coverage") {
        const isService =
          cat.prefix === "SAF" ||
          cat.prefix === "HLT" ||
          cat.prefix === "EDU" ||
          cat.id === "CIV-03" ||
          cat.id === "TRN-01" ||
          cat.id === "TRN-09";
        if (!isService) continue;
        const radius = cat.id === "TRN-09" ? 15 : cat.prefix === "SAF" || cat.prefix === "HLT" ? 26 : 20;
        const disc = new THREE.Mesh(
          new THREE.CircleGeometry(radius, 28),
          new THREE.MeshBasicMaterial({
            color: cat.id === "TRN-09" ? 0x38bdf8 : 0x10b981,
            transparent: true,
            opacity: 0.2,
            depthWrite: false,
          })
        );
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(cx, 0.14, cz);
        this.overlayRingsGroup.add(disc);
      }
    }
  }

  public setTrafficState(traffic: TrafficStateDto): void {
    this.trafficRenderer.setTraffic(traffic);
    this.rebuildBusRoutes(traffic.busRoutes);
  }

  public setSelectedVehicle(vehicleId: string | null): void {
    this.trafficRenderer.setSelected(vehicleId);
    if (!vehicleId) this.followVehicleId = null;
  }

  /** Keeps the camera centred on a moving vehicle until the player pans or picks something else. */
  public followVehicle(vehicleId: string | null): void {
    this.followVehicleId = vehicleId;
    if (vehicleId && this.zoomLevel < 5) this.zoomLevel = 7;
  }

  /** Underground Overlay (GDD §5.4): metro tunnels and trains; the surface fades to a ghost. */
  public setUndergroundView(on: boolean): void {
    this.undergroundView = on;
    this.roadBuilder.setUndergroundView(on);
    this.trafficRenderer.setUndergroundView(on);
    this.lotGenerator.group.visible = !on;
    this.foliageGroup.visible = !on;
    this.busRoutesGroup.visible = !on;
    if (this.terrainMesh) {
      const mat = this.terrainMesh.material as THREE.MeshLambertMaterial;
      mat.color.setHex(on ? 0x2a2f45 : 0xffffff);
    }
  }

  private rebuildBusRoutes(routes: readonly BusRouteStatusDto[]): void {
    while (this.busRoutesGroup.children.length > 0) {
      const child = this.busRoutesGroup.children.pop()! as THREE.Mesh;
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
    routes.forEach((route, idx) => {
      if (!route.operating) return;
      const mat = new THREE.MeshBasicMaterial({ color: ROUTE_COLORS[idx % ROUTE_COLORS.length]!, transparent: true, opacity: 0.75 });
      for (let i = 2; i < route.path.length; i += 2) {
        const ax = route.path[i - 2]!;
        const az = route.path[i - 1]!;
        const bx = route.path[i]!;
        const bz = route.path[i + 1]!;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.05) continue;
        const ribbon = new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, 0.32), mat.clone());
        ribbon.position.set((ax + bx) / 2, 0.36, (az + bz) / 2);
        ribbon.rotation.y = -Math.atan2(bz - az, bx - ax);
        this.busRoutesGroup.add(ribbon);
      }
      mat.dispose();
    });
  }

  private nearestRoadSegmentId(tileX: number, tileY: number, maxDistance: number): string | null {
    if (!this.lastSnapshot) return null;
    let best: string | null = null;
    let bestD = maxDistance;
    for (const seg of this.lastSnapshot.segments) {
      if (!["street_2lane", "avenue_4lane", "express_6lane", "heavy_bypass"].includes(seg.kind)) continue;
      const vx = seg.toX - seg.fromX;
      const vy = seg.toY - seg.fromY;
      const len2 = vx * vx + vy * vy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((tileX - seg.fromX) * vx + (tileY - seg.fromY) * vy) / len2));
      const d = Math.hypot(tileX - (seg.fromX + vx * t), tileY - (seg.fromY + vy * t));
      if (d < bestD) {
        bestD = d;
        best = seg.id;
      }
    }
    return best;
  }

  public focusOverview(): void {
    this.target.set(500, 0, 500);
    this.zoomLevel = 0.85;
    this.updateCameraTransform();
  }

  public loadMapTerrain(
    surfaceBytes: Uint8Array,
    ownerBytes: Uint8Array,
    gateways: readonly ExternalGatewayPoint[],
    deposits: readonly ResourceDepositSite[]
  ): void {
    this.surfaceBytes = surfaceBytes;
    this.ownerBytes = ownerBytes;

    const rgba = new Uint8Array(GRID_WIDTH * GRID_HEIGHT * 4);
    for (let y = 0; y < GRID_HEIGHT; y++) {
      const rowOff = y * GRID_WIDTH;
      for (let x = 0; x < GRID_WIDTH; x++) {
        const idx = rowOff + x;
        const surf = surfaceBytes[idx]!;
        const ow = ownerBytes[idx]!;
        let r = 11;
        let g = 38;
        let b = 69;

        if (surf === SurfaceType.Mainland) {
          r = 78;
          g = 92;
          b = 82;
        } else if (surf === SurfaceType.River) {
          r = 28;
          g = 118;
          b = 196;
        } else if (surf === SurfaceType.Land) {
          const base = SECTOR_LAND_RGB[ow] ?? [96, 132, 96];
          const checker = ((x >> 2) + (y >> 2)) & 1 ? 4 : -3;
          r = base[0] + checker;
          g = base[1] + checker;
          b = base[2] + checker;

          // Highlight sector boundary lines & Central Core golden ring
          const rightOw = x + 1 < GRID_WIDTH ? ownerBytes[idx + 1]! : ow;
          const downOw = y + 1 < GRID_HEIGHT ? ownerBytes[idx + GRID_WIDTH]! : ow;
          if (rightOw !== ow || downOw !== ow) {
            if (ow === OwnerCode.CentralCore || rightOw === OwnerCode.CentralCore || downOw === OwnerCode.CentralCore) {
              r = 245;
              g = 190;
              b = 45;
            } else if (rightOw !== OwnerCode.None && downOw !== OwnerCode.None) {
              r = 226;
              g = 232;
              b = 240;
            } else {
              // Sandy coastline rim
              r = 214;
              g = 196;
              b = 148;
            }
          }
        } else {
          // Coastal shallow water glow near land
          const nearLand =
            (x > 3 && surfaceBytes[idx - 3] === SurfaceType.Land) ||
            (x + 3 < GRID_WIDTH && surfaceBytes[idx + 3] === SurfaceType.Land) ||
            (y > 3 && surfaceBytes[idx - 3 * GRID_WIDTH] === SurfaceType.Land) ||
            (y + 3 < GRID_HEIGHT && surfaceBytes[idx + 3 * GRID_WIDTH] === SurfaceType.Land);
          if (nearLand) {
            r = 18;
            g = 68;
            b = 112;
          }
        }

        const p = idx * 4;
        rgba[p] = r;
        rgba[p + 1] = g;
        rgba[p + 2] = b;
        rgba[p + 3] = 255;
      }
    }

    const tex = new THREE.DataTexture(rgba, GRID_WIDTH, GRID_HEIGHT, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
    }

    const planeGeo = new THREE.PlaneGeometry(GRID_WIDTH, GRID_HEIGHT);
    planeGeo.rotateX(-Math.PI / 2);
    const planeMat = new THREE.MeshLambertMaterial({ map: tex });
    this.terrainMesh = new THREE.Mesh(planeGeo, planeMat);
    // Notice: PlaneGeometry after rotateX(-PI/2) maps UV v=0 to +Z and v=1 to -Z unless flipped;
    // setting repeat.y = -1 & offset.y = 1 aligns DataTexture row `y` cleanly with world `+Z = y`!
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = false;
    this.terrainMesh.position.set(GRID_WIDTH * 0.5, 0, GRID_HEIGHT * 0.5);
    this.terrainMesh.receiveShadow = true;
    this.scene.add(this.terrainMesh);

    this.depositsCache = deposits;
    this.buildStaticMarkers(gateways, deposits);
    this.lastFoliageSignature = "";
    this.rebuildFoliage();
  }

  private buildStaticMarkers(
    gateways: readonly ExternalGatewayPoint[],
    deposits: readonly ResourceDepositSite[]
  ): void {
    while (this.markersGroup.children.length > 0) {
      this.markersGroup.remove(this.markersGroup.children[0]!);
    }

    // 1. Central Core Landmark Monument Ring at (500, 500)
    const coreRingGeo = new THREE.RingGeometry(58.5, 60.5, 64);
    coreRingGeo.rotateX(-Math.PI / 2);
    const coreRingMat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.7,
    });
    const coreRing = new THREE.Mesh(coreRingGeo, coreRingMat);
    coreRing.position.set(CORE_CENTER_X, 0.12, CORE_CENTER_Y);
    this.markersGroup.add(coreRing);

    // 2. Five External World Gateways (glowing cyan archways)
    for (const gw of gateways) {
      const archGeo = new THREE.BoxGeometry(5.5, 4.2, 2.2);
      const archMat = new THREE.MeshLambertMaterial({
        color: gw.kind === "overland_highway" ? 0x22d3ee : 0xa855f7,
      });
      const arch = new THREE.Mesh(archGeo, archMat);
      arch.position.set(gw.tileX, 2.1, gw.tileY);
      arch.castShadow = true;
      this.markersGroup.add(arch);
    }

    // 3. 25 Resource Deposit Sites (subtle ring + mineral crystal marker)
    const resourceColors: Record<string, number> = {
      "Iron Ore": 0xb45309,
      Coal: 0x334155,
      "Crude Oil": 0x0f172a,
      "Natural Gas": 0x38bdf8,
      Grain: 0xeab308,
      Timber: 0x15803d,
      "Limestone & Granite": 0xd6d3d1,
      "Quartz & Silica Sand": 0xfde047,
    };

    for (const dep of deposits) {
      const col = resourceColors[dep.resourceName] ?? 0x94a3b8;
      const ringGeo = new THREE.RingGeometry(dep.radiusTiles - 0.8, dep.radiusTiles, 28);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({
        color: col,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: dep.role === "Profile" ? 0.65 : 0.35,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(dep.tileX, 0.09, dep.tileY);
      this.markersGroup.add(ring);

      const coneGeo = new THREE.ConeGeometry(
        dep.role === "Profile" ? 2.8 : 1.7,
        dep.role === "Profile" ? 5.5 : 3.2,
        6
      );
      const coneMat = new THREE.MeshLambertMaterial({ color: col });
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.set(dep.tileX, dep.role === "Profile" ? 2.75 : 1.6, dep.tileY);
      cone.castShadow = true;
      this.markersGroup.add(cone);
    }
  }

  public applySnapshot(snapshot: WorldSnapshotDto): void {
    this.lastSnapshot = snapshot;
    this.roadBuilder.rebuild(snapshot.segments);
    this.roadBuilder.setUndergroundView(this.undergroundView);
    this.lotGenerator.rebuild(
      snapshot.buildings,
      snapshot.zones,
      this.catalogs,
      this.selectedBuildingId,
      new Map(snapshot.zoneSites.map((z) => [z.zoneId, z])),
      new Map(snapshot.districts.map((d) => [d.zoneId, d])),
      this.heatmapOverlay
    );
    this.rebuildEmergencies(snapshot.emergencies);
    this.rebuildOverlayRings();

    const sig = `${snapshot.segments.length}|${snapshot.zones.length}|${snapshot.buildings.length}|${
      snapshot.segments[snapshot.segments.length - 1]?.id ?? ""
    }|${snapshot.zones[snapshot.zones.length - 1]?.id ?? ""}|${
      snapshot.buildings[snapshot.buildings.length - 1]?.id ?? ""
    }`;
    if (sig !== this.lastFoliageSignature) {
      this.lastFoliageSignature = sig;
      this.rebuildFoliage();
    }
  }

  /**
   * Procedural Instanced Foliage (`rebuildFoliage()`):
   * 2 `THREE.InstancedMesh`es (trunks + crowns = 2 draw calls across the entire 1000×1000 map,
   * up to 20,000 trees) placed via deterministic coordinate noise on unoccupied `SurfaceType.Land`,
   * riverbanks, parks (`CIV-03`, `CIV-06`, `CIV-07`, `LEI-*`), and residential yards (`RES-01`, `RES-02`),
   * with 78% lush greens and 22% autumn crimson/orange accents.
   */
  public rebuildFoliage(): void {
    const surface = this.surfaceBytes;
    const owner = this.ownerBytes;
    if (!surface || !owner) return;

    if (!this.foliageTrunks || !this.foliageCrowns) {
      const trunkGeo = new THREE.CylinderGeometry(0.09, 0.15, 0.72, 5);
      trunkGeo.translate(0, 0.36, 0);
      this.foliageTrunks = new THREE.InstancedMesh(
        trunkGeo,
        new THREE.MeshLambertMaterial({ color: 0x5c4033 }),
        MAX_FOLIAGE_TREES
      );
      this.foliageTrunks.castShadow = false;
      this.foliageTrunks.receiveShadow = true;
      this.foliageTrunks.frustumCulled = false;

      const crownGeo = new THREE.DodecahedronGeometry(0.68, 0);
      crownGeo.scale(1, 1.18, 1);
      crownGeo.translate(0, 1.15, 0);
      this.foliageCrowns = new THREE.InstancedMesh(
        crownGeo,
        new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
        MAX_FOLIAGE_TREES
      );
      this.foliageCrowns.castShadow = true;
      this.foliageCrowns.receiveShadow = true;
      this.foliageCrowns.frustumCulled = false;

      this.foliageGroup.add(this.foliageTrunks);
      this.foliageGroup.add(this.foliageCrowns);
    }

    // 0 = free land, 1 = blocked (road/building/deposit/non-yard zone), 2 = park, 3 = RES-01/02 yard
    const mask = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
    const markRect = (x0: number, y0: number, w: number, d: number, code: number) => {
      const minX = Math.max(0, Math.floor(x0));
      const maxX = Math.min(GRID_WIDTH - 1, Math.ceil(x0 + w));
      const minY = Math.max(0, Math.floor(y0));
      const maxY = Math.min(GRID_HEIGHT - 1, Math.ceil(y0 + d));
      for (let y = minY; y <= maxY; y++) {
        const row = y * GRID_WIDTH;
        for (let x = minX; x <= maxX; x++) {
          mask[row + x] = code;
        }
      }
    };

    for (const dep of this.depositsCache) {
      const r = Math.min(6, Math.ceil(dep.radiusTiles * 0.45));
      markRect(dep.tileX - r, dep.tileY - r, r * 2, r * 2, 1);
    }

    const snap = this.lastSnapshot;
    if (snap) {
      for (const z of snap.zones) {
        if (z.zoneKind === "RES-01" || z.zoneKind === "RES-02") {
          markRect(z.x, z.y, z.width, z.depth, 3);
        } else {
          markRect(z.x - 1, z.y - 1, z.width + 2, z.depth + 2, 1);
        }
      }

      for (const b of snap.buildings) {
        const isPark =
          b.catalogId === "CIV-03" ||
          b.catalogId === "CIV-06" ||
          b.catalogId === "CIV-07" ||
          b.catalogId === "LEI-10" ||
          b.catalogId === "LEI-11" ||
          b.catalogId === "LEI-14";
        if (isPark) {
          markRect(b.tileX, b.tileY, b.width, b.depth, 2);
        } else {
          markRect(b.tileX - 1, b.tileY - 1, b.width + 2, b.depth + 2, 1);
        }
      }

      for (const seg of snap.segments) {
        if (seg.kind === "metro_tunnel") continue;
        const dx = seg.toX - seg.fromX;
        const dy = seg.toY - seg.fromY;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
        const pad = seg.kind === "express_6lane" || seg.kind === "heavy_bypass" ? 3 : 2;
        for (let i = 0; i <= steps; i++) {
          const sx = Math.round(seg.fromX + (dx * i) / steps);
          const sy = Math.round(seg.fromY + (dy * i) / steps);
          markRect(sx - pad, sy - pad, pad * 2, pad * 2, 1);
        }
      }
    }

    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    let count = 0;

    const placeTree = (wx: number, wz: number, scale: number, hVal: number) => {
      if (count >= MAX_FOLIAGE_TREES) return;
      dummy.position.set(wx, 0, wz);
      dummy.rotation.set(0, ((hVal & 255) / 255) * Math.PI * 2, 0);
      dummy.scale.set(scale, scale * (0.9 + ((hVal >>> 8) & 31) / 100), scale);
      dummy.updateMatrix();
      this.foliageTrunks!.setMatrixAt(count, dummy.matrix);
      this.foliageCrowns!.setMatrixAt(count, dummy.matrix);

      // 78% lush greens (#15803d, #16a34a, #22c55e, #4d7c0f) + 22% autumn accents (#dc2626, #ea580c, #d97706)
      const roll = (hVal >>> 16) % 100;
      const hex =
        roll < 78
          ? FOLIAGE_GREEN_HEX[hVal % FOLIAGE_GREEN_HEX.length]!
          : FOLIAGE_AUTUMN_HEX[hVal % FOLIAGE_AUTUMN_HEX.length]!;
      this.foliageCrowns!.setColorAt(count, col.setHex(hex));
      count++;
    };

    // Pass 1: Planted urban trees inside parks (`mask === 2`) and residential yards (`mask === 3`)
    if (snap) {
      for (const b of snap.buildings) {
        const idx0 = b.tileY * GRID_WIDTH + b.tileX;
        if (mask[idx0] !== 2) continue;
        for (let y = b.tileY + 1; y < b.tileY + b.depth - 1 && count < MAX_FOLIAGE_TREES; y += 2) {
          for (let x = b.tileX + 1; x < b.tileX + b.width - 1 && count < MAX_FOLIAGE_TREES; x += 2) {
            const h = tileHash(x, y, 71);
            if ((h % 10) < 6) {
              placeTree(x + 0.5, y + 0.5, 0.85 + (h % 25) * 0.01, h);
            }
          }
        }
      }

      for (const z of snap.zones) {
        if (z.zoneKind !== "RES-01" && z.zoneKind !== "RES-02") continue;
        const step = z.zoneKind === "RES-01" ? 3 : 4;
        for (let y = z.y; y <= z.y + z.depth && count < MAX_FOLIAGE_TREES; y += step) {
          for (let x = z.x; x <= z.x + z.width && count < MAX_FOLIAGE_TREES; x += step) {
            if (x < 0 || x >= GRID_WIDTH || y < 0 || y >= GRID_HEIGHT) continue;
            if (mask[y * GRID_WIDTH + x] === 1) continue;
            const h = tileHash(x, y, 89);
            if ((h % 10) < 7) {
              placeTree(x + 0.15, y + 0.15, 0.72 + (h % 20) * 0.01, h);
            }
          }
        }
      }
    }

    // Pass 2: Natural forests & riverbank groves across unoccupied `SurfaceType.Land`
    for (let y = 4; y < GRID_HEIGHT - 4 && count < MAX_FOLIAGE_TREES; y += 3) {
      const rowOff = y * GRID_WIDTH;
      for (let x = 4; x < GRID_WIDTH - 4 && count < MAX_FOLIAGE_TREES; x += 3) {
        const idx = rowOff + x;
        if (surface[idx] !== SurfaceType.Land || mask[idx] !== 0) continue;
        const ow = owner[idx]!;
        if (ow === OwnerCode.CentralCore) {
          const distCore = Math.hypot(x - CORE_CENTER_X, y - CORE_CENTER_Y);
          if (distCore > 55 && distCore < 63) continue;
        }

        const nearRiver =
          surface[idx - 2] === SurfaceType.River ||
          surface[idx + 2] === SurfaceType.River ||
          surface[idx - 2 * GRID_WIDTH] === SurfaceType.River ||
          surface[idx + 2 * GRID_WIDTH] === SurfaceType.River;

        const h = tileHash(x, y, 37);
        const cluster = forestClusterNoise(x, y);
        const sectorDensityBonus = ow === OwnerCode.Sector3 ? 0.12 : ow === OwnerCode.Sector4 ? 0.06 : 0;
        const spawnChance = nearRiver ? 0.58 : cluster > 0.53 - sectorDensityBonus ? (cluster - 0.35) * 0.52 : 0.025;

        if ((h & 1023) / 1023 < spawnChance) {
          const jx = ((h >>> 10) & 31) / 31 - 0.5;
          const jz = ((h >>> 15) & 31) / 31 - 0.5;
          const scale = 0.8 + ((h >>> 20) & 31) / 64;
          placeTree(x + 0.5 + jx * 1.6, y + 0.5 + jz * 1.6, scale, h);
        }
      }
    }

    this.foliageTrunks.count = count;
    this.foliageCrowns.count = count;
    this.foliageTrunks.instanceMatrix.needsUpdate = true;
    this.foliageCrowns.instanceMatrix.needsUpdate = true;
    if (this.foliageCrowns.instanceColor) {
      this.foliageCrowns.instanceColor.needsUpdate = true;
    }
  }

  private rebuildEmergencies(emergencies: readonly ActiveEmergencyDto[]): void {
    while (this.emergenciesGroup.children.length > 0) {
      this.emergenciesGroup.remove(this.emergenciesGroup.children[0]!);
    }
    for (const emg of emergencies) {
      // Amber: frozen construction; orange: crews on the way; red: nobody is coming
      const col = emg.emergencyId === "FROZEN_CONSTRUCTION" ? 0xf59e0b : emg.attended ? 0xf97316 : 0xef4444;
      const geo = new THREE.CylinderGeometry(0.6, 2.2, 18, 12, 1, true);
      const mat = new THREE.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
      });
      const beacon = new THREE.Mesh(geo, mat);
      beacon.position.set(emg.tileX, 9, emg.tileY);
      this.emergenciesGroup.add(beacon);
    }
  }

  private rebuildPreview(): void {
    while (this.previewGroup.children.length > 0) {
      this.previewGroup.remove(this.previewGroup.children[0]!);
    }
    const hover = this.currentHoverTile;
    if (!hover) return;

    if (this.tool.mode === "network") {
      if (this.dragStartTile) {
        const snapped = snapToHybridGrid45(
          this.dragStartTile.x,
          this.dragStartTile.y,
          hover.tileX,
          hover.tileY
        );
        const dx = snapped.toX - this.dragStartTile.x;
        const dz = snapped.toY - this.dragStartTile.y;
        const len = Math.max(1, Math.hypot(dx, dz));
        const geo = new THREE.BoxGeometry(len, 0.35, 1.8);
        const mat = new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.7,
        });
        const ribbon = new THREE.Mesh(geo, mat);
        ribbon.position.set(
          this.dragStartTile.x + dx * 0.5,
          this.tool.isFlyover ? 1.6 : 0.28,
          this.dragStartTile.y + dz * 0.5
        );
        ribbon.rotation.y = -Math.atan2(dz, dx);
        this.previewGroup.add(ribbon);
      } else {
        const cursor = new THREE.Mesh(
          new THREE.BoxGeometry(2, 0.3, 2),
          new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.65 })
        );
        cursor.position.set(hover.tileX + 0.5, 0.2, hover.tileY + 0.5);
        this.previewGroup.add(cursor);
      }
      return;
    }

    if (this.tool.mode === "zone") {
      const s = this.tool.brushSize;
      const ghost = new THREE.Mesh(
        new THREE.BoxGeometry(s, 0.3, s),
        new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.5 })
      );
      ghost.position.set(hover.tileX + s * 0.5, 0.2, hover.tileY + s * 0.5);
      this.previewGroup.add(ghost);
      return;
    }

    if (this.tool.mode === "bus_route") {
      const chosen = new Set(this.tool.stopIds);
      for (const b of this.lastSnapshot?.buildings ?? []) {
        if (b.catalogId !== "TRN-01") continue;
        const order = this.tool.stopIds.indexOf(b.id);
        const ring = new THREE.Mesh(
          new THREE.CylinderGeometry(chosen.has(b.id) ? 2.4 : 1.8, chosen.has(b.id) ? 2.4 : 1.8, chosen.has(b.id) ? 3 + order * 0.4 : 1.2, 16),
          new THREE.MeshBasicMaterial({ color: chosen.has(b.id) ? 0xfacc15 : 0x38bdf8, transparent: true, opacity: 0.55 })
        );
        ring.position.set(b.tileX + b.width / 2, 1, b.tileY + b.depth / 2);
        this.previewGroup.add(ring);
      }
      return;
    }

    if (this.tool.mode === "repair") {
      const segId = this.nearestRoadSegmentId(hover.tileX, hover.tileY, 3);
      const seg = segId ? this.lastSnapshot?.segments.find((s) => s.id === segId) : undefined;
      if (seg) {
        const dx = seg.toX - seg.fromX;
        const dz = seg.toY - seg.fromY;
        const ghost = new THREE.Mesh(
          new THREE.BoxGeometry(Math.hypot(dx, dz) + 1, 0.5, 2.6),
          new THREE.MeshBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.55 })
        );
        ghost.position.set(seg.fromX + dx / 2, 0.3, seg.fromY + dz / 2);
        ghost.rotation.y = -Math.atan2(dz, dx);
        this.previewGroup.add(ghost);
      }
      return;
    }

    if (this.tool.mode === "demolish") {
      const snap = this.lastSnapshot;
      if (snap) {
        const b = snap.buildings.find(
          (x) =>
            hover.tileX >= x.tileX &&
            hover.tileX < x.tileX + x.width &&
            hover.tileY >= x.tileY &&
            hover.tileY < x.tileY + x.depth
        );
        if (b) {
          const ghost = new THREE.Mesh(
            new THREE.BoxGeometry(b.width + 0.3, 3.6, b.depth + 0.3),
            new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.55 })
          );
          ghost.position.set(b.tileX + b.width * 0.5, 1.85, b.tileY + b.depth * 0.5);
          this.previewGroup.add(ghost);
          return;
        }
        const z = snap.zones.find(
          (x) =>
            hover.tileX >= x.x &&
            hover.tileX < x.x + x.width &&
            hover.tileY >= x.y &&
            hover.tileY < x.y + x.depth
        );
        if (z) {
          const ghost = new THREE.Mesh(
            new THREE.BoxGeometry(z.width + 0.2, 0.7, z.depth + 0.2),
            new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.5 })
          );
          ghost.position.set(z.x + z.width * 0.5, 0.38, z.y + z.depth * 0.5);
          this.previewGroup.add(ghost);
          return;
        }
      }
      const cursor = new THREE.Mesh(
        new THREE.BoxGeometry(2, 0.35, 2),
        new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.6 })
      );
      cursor.position.set(hover.tileX + 0.5, 0.22, hover.tileY + 0.5);
      this.previewGroup.add(cursor);
      return;
    }

    if (this.tool.mode === "building") {
      const { width, depth } = this.tool;
      const valid = hover.surface === SurfaceType.Land;
      const ghost = new THREE.Mesh(
        new THREE.BoxGeometry(width, 3.2, depth),
        new THREE.MeshBasicMaterial({
          color: valid ? 0x22c55e : 0xef4444,
          transparent: true,
          opacity: 0.5,
        })
      );
      ghost.position.set(hover.tileX + width * 0.5, 1.65, hover.tileY + depth * 0.5);
      this.previewGroup.add(ghost);
    }
  }

  public getCameraState(): {
    readonly centerX: number;
    readonly centerY: number;
    readonly zoomLevel: number;
    readonly waterRatio: number;
  } {
    const cx = Math.max(0, Math.min(GRID_WIDTH - 1, Math.round(this.target.x)));
    const cy = Math.max(0, Math.min(GRID_HEIGHT - 1, Math.round(this.target.z)));
    let waterHits = 0;
    let totalSamples = 0;
    if (this.surfaceBytes) {
      for (const dy of [-10, 0, 10]) {
        for (const dx of [-10, 0, 10]) {
          const sx = Math.max(0, Math.min(GRID_WIDTH - 1, cx + dx));
          const sy = Math.max(0, Math.min(GRID_HEIGHT - 1, cy + dy));
          totalSamples += 1;
          const surf = this.surfaceBytes[sy * GRID_WIDTH + sx]!;
          if (surf === SurfaceType.Sea || surf === SurfaceType.River) {
            waterHits += 1;
          }
        }
      }
    }
    return {
      centerX: cx,
      centerY: cy,
      zoomLevel: this.zoomLevel,
      waterRatio: totalSamples > 0 ? waterHits / totalSamples : 0,
    };
  }

  private updateCameraTransform(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const aspect = w / h;

    this.camera.left = (-this.frustumHalfHeight * aspect) / this.zoomLevel;
    this.camera.right = (this.frustumHalfHeight * aspect) / this.zoomLevel;
    this.camera.top = this.frustumHalfHeight / this.zoomLevel;
    this.camera.bottom = -this.frustumHalfHeight / this.zoomLevel;
    this.camera.updateProjectionMatrix();

    // True 2:1 isometric camera offset (`45°` azimuth, `35.264°` pitch)
    const dist = 900;
    this.camera.position.set(
      this.target.x + dist,
      this.target.y + dist * 0.8165,
      this.target.z + dist
    );
    this.camera.lookAt(this.target);
  }

  private screenToTile(clientX: number, clientY: number): HoveredTileInfo | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);

    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    const tileX = Math.floor(hit.x);
    const tileY = Math.floor(hit.z);
    if (tileX < 0 || tileX >= GRID_WIDTH || tileY < 0 || tileY >= GRID_HEIGHT) return null;

    const idx = tileY * GRID_WIDTH + tileX;
    return {
      tileX,
      tileY,
      owner: this.ownerBytes ? this.ownerBytes[idx]! : 0,
      surface: this.surfaceBytes ? this.surfaceBytes[idx]! : 0,
    };
  }

  private pickBuildingAt(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects(this.lotGenerator.group.children, true);
    for (const h of hits) {
      let obj: THREE.Object3D | null = h.object;
      while (obj) {
        if (typeof obj.userData?.buildingId === "string") {
          return obj.userData.buildingId;
        }
        obj = obj.parent;
      }
    }
    return null;
  }

  private bindEvents(): void {
    const dom = this.renderer.domElement;

    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.16 : 1 / 1.16;
      this.zoomLevel = Math.max(0.55, Math.min(14, this.zoomLevel * factor));
      this.updateCameraTransform();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 2 || e.button === 1 || this.keysPressed.has("Space")) {
        this.isPanning = true;
        this.followVehicleId = null;
        this.lastPointerX = e.clientX;
        this.lastPointerY = e.clientY;
        return;
      }

      if (e.button !== 0) return;
      const tile = this.screenToTile(e.clientX, e.clientY);
      if (!tile) return;

      if (this.tool.mode === "inspect") {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const vehicleId = this.trafficRenderer.pickNearest(e.clientX, e.clientY, this.camera, rect);
        if (vehicleId) {
          this.callbacks.onSelectVehicle?.(vehicleId);
          return;
        }
        const bId = this.undergroundView ? null : this.pickBuildingAt(e.clientX, e.clientY);
        this.setSelectedBuilding(bId);
        this.callbacks.onSelectBuilding?.(bId);
        this.callbacks.onSelectVehicle?.(null);
        return;
      }

      if (this.tool.mode === "bus_route") {
        const bId = this.pickBuildingAt(e.clientX, e.clientY);
        const b = bId ? this.lastSnapshot?.buildings.find((x) => x.id === bId) : undefined;
        if (b?.catalogId === "TRN-01") this.callbacks.onToggleBusStop?.(b.id);
        return;
      }

      if (this.tool.mode === "repair") {
        const segId = this.nearestRoadSegmentId(tile.tileX, tile.tileY, 3);
        if (segId) this.callbacks.onRepairSegment?.(segId);
        return;
      }

      if (this.tool.mode === "demolish") {
        const bId = this.pickBuildingAt(e.clientX, e.clientY);
        if (bId) {
          this.callbacks.onDemolishBuilding?.(bId);
          return;
        }
        const z = this.lastSnapshot?.zones.find(
          (x) =>
            tile.tileX >= x.x &&
            tile.tileX < x.x + x.width &&
            tile.tileY >= x.y &&
            tile.tileY < x.y + x.depth
        );
        if (z) {
          this.callbacks.onDemolishZone?.(z.id);
        }
        return;
      }

      if (this.tool.mode === "network") {
        this.dragStartTile = { x: tile.tileX, y: tile.tileY };
        this.rebuildPreview();
        return;
      }

      if (this.tool.mode === "zone") {
        this.callbacks.onPaintZone?.(
          tile.tileX,
          tile.tileY,
          this.tool.brushSize,
          this.tool.brushSize,
          this.tool.zoneKind
        );
        return;
      }

      if (this.tool.mode === "building") {
        this.callbacks.onPlaceBuilding?.(
          tile.tileX,
          tile.tileY,
          this.tool.catalogId,
          this.tool.orientationDeg
        );
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (this.isPanning) {
        const dx = e.clientX - this.lastPointerX;
        const dy = e.clientY - this.lastPointerY;
        this.lastPointerX = e.clientX;
        this.lastPointerY = e.clientY;

        const panScale = (this.frustumHalfHeight * 2) / (Math.max(1, this.container.clientHeight) * this.zoomLevel);
        // Convert screen delta into isometric ground plane (+X/-Z for horizontal, +X/+Z for vertical)
        const isoX = (-dx * 0.7071 - dy * 0.866) * panScale;
        const isoZ = (dx * 0.7071 - dy * 0.866) * panScale;
        this.target.x = Math.max(40, Math.min(960, this.target.x + isoX));
        this.target.z = Math.max(40, Math.min(960, this.target.z + isoZ));
        this.updateCameraTransform();
        return;
      }

      const tile = this.screenToTile(e.clientX, e.clientY);
      this.currentHoverTile = tile;
      this.callbacks.onHoverTile?.(tile);
      this.rebuildPreview();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (this.isPanning) {
        this.isPanning = false;
        return;
      }
      if (e.button === 0 && this.tool.mode === "network" && this.dragStartTile) {
        const endTile = this.screenToTile(e.clientX, e.clientY);
        const start = this.dragStartTile;
        this.dragStartTile = null;
        this.rebuildPreview();
        if (endTile) {
          const snapped = snapToHybridGrid45(start.x, start.y, endTile.tileX, endTile.tileY);
          if (snapped.toX !== start.x || snapped.toY !== start.y) {
            this.callbacks.onBuildSegment?.(
              start.x,
              start.y,
              snapped.toX,
              snapped.toY,
              this.tool.kind,
              this.tool.isFlyover
            );
          }
        }
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement
      ) {
        return;
      }
      this.keysPressed.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.keysPressed.delete(e.code);
    };
    const onResize = () => {
      const w = Math.max(1, this.container.clientWidth);
      const h = Math.max(1, this.container.clientHeight);
      this.renderer.setSize(w, h);
      this.updateCameraTransform();
    };

    dom.addEventListener("contextmenu", onContextMenu);
    dom.addEventListener("wheel", onWheel, { passive: false });
    dom.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("resize", onResize);

    this.cleanupListeners = () => {
      dom.removeEventListener("contextmenu", onContextMenu);
      dom.removeEventListener("wheel", onWheel);
      dom.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
    };
  }

  private cleanupListeners: (() => void) | null = null;

  private animate = (): void => {
    this.rafId = requestAnimationFrame(this.animate);
    const dt = Math.min(0.1, this.clock.getDelta());
    const elapsed = this.clock.elapsedTime;

    // Keyboard WASD / Arrow panning
    const speed = (280 / this.zoomLevel) * dt;
    let moveIsoX = 0;
    let moveIsoY = 0;
    if (this.keysPressed.has("KeyW") || this.keysPressed.has("ArrowUp")) moveIsoY -= 1;
    if (this.keysPressed.has("KeyS") || this.keysPressed.has("ArrowDown")) moveIsoY += 1;
    if (this.keysPressed.has("KeyA") || this.keysPressed.has("ArrowLeft")) moveIsoX -= 1;
    if (this.keysPressed.has("KeyD") || this.keysPressed.has("ArrowRight")) moveIsoX += 1;

    if (moveIsoX !== 0 || moveIsoY !== 0) {
      this.followVehicleId = null;
      const dx = (moveIsoX * 0.7071 + moveIsoY * 0.7071) * speed;
      const dz = (-moveIsoX * 0.7071 + moveIsoY * 0.7071) * speed;
      this.target.x = Math.max(40, Math.min(960, this.target.x + dx));
      this.target.z = Math.max(40, Math.min(960, this.target.z + dz));
      this.updateCameraTransform();
    }

    this.trafficRenderer.update(elapsed);
    this.roadBuilder.updateSignals(elapsed);
    if (this.followVehicleId) {
      const pos = this.trafficRenderer.getVehiclePosition(this.followVehicleId);
      if (pos) {
        this.target.set(pos.x, 0, pos.z);
        this.updateCameraTransform();
      }
    }
    this.lotGenerator.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  public dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.cleanupListeners?.();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
