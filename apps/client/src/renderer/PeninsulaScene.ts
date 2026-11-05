/**
 * Crisp 2:1 Orthographic Isometric Peninsula Renderer (`PeninsulaScene.ts`).
 *
 * Renders the 1000×1000 flat peninsula (`Z = 0`, `Z = +1` bridges/flyovers) with:
 * - Zero fog of war across all 5 sovereign sectors + Central Core `(500, 500)`;
 * - Pixel-crisp `DataTexture` terrain (`NearestFilter` magnification) with sector borders & rivers;
 * - 5 External World Gateway portals + 25 color-coded Resource Deposit beacons;
 * - Active Urban Emergency columns;
 * - Smooth pan (`Right/Middle Drag` or `WASD` / Arrows), zoom (`Mouse Wheel`), raycast picking,
 *   and live 90°/45° network & building footprint preview!
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
  type ExternalGatewayPoint,
  type MasterCatalogs,
  type NetworkKind,
  type ResourceDepositSite,
  type SectorId,
  type WorldSnapshotDto,
  type ZoneKind,
} from "@pentapolis/shared-sim";
import { RoadMeshBuilder } from "./RoadMeshBuilder.ts";
import { LotGenerator } from "./LotGenerator.ts";

export type ActiveToolState =
  | { mode: "inspect" }
  | { mode: "network"; kind: NetworkKind; isFlyover: boolean }
  | { mode: "zone"; zoneKind: ZoneKind; brushSize: number }
  | { mode: "building"; catalogId: string; width: number; depth: number; orientationDeg: 0 | 45 | 90 | 135 };

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
}

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
  private readonly markersGroup = new THREE.Group();
  private readonly emergenciesGroup = new THREE.Group();
  private readonly previewGroup = new THREE.Group();

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
    this.scene.add(this.roadBuilder.group);
    this.scene.add(this.lotGenerator.group);
    this.scene.add(this.emergenciesGroup);
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
        this.selectedBuildingId
      );
    }
  }

  public focusSector(sectorId: SectorId | "core", zoom = 3.4): void {
    const [tx, tz] = SECTOR_FOCUS_TILES[sectorId];
    this.target.set(tx, 0, tz);
    this.zoomLevel = zoom;
    this.updateCameraTransform();
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

    this.buildStaticMarkers(gateways, deposits);
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
    this.lotGenerator.rebuild(
      snapshot.buildings,
      snapshot.zones,
      this.catalogs,
      this.selectedBuildingId
    );
    this.rebuildEmergencies(snapshot.emergencies);
  }

  private rebuildEmergencies(emergencies: readonly ActiveEmergencyDto[]): void {
    while (this.emergenciesGroup.children.length > 0) {
      this.emergenciesGroup.remove(this.emergenciesGroup.children[0]!);
    }
    for (const emg of emergencies) {
      const col = emg.emergencyId === "FROZEN_CONSTRUCTION" ? 0xf59e0b : 0xef4444;
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
        this.lastPointerX = e.clientX;
        this.lastPointerY = e.clientY;
        return;
      }

      if (e.button !== 0) return;
      const tile = this.screenToTile(e.clientX, e.clientY);
      if (!tile) return;

      if (this.tool.mode === "inspect") {
        const bId = this.pickBuildingAt(e.clientX, e.clientY);
        this.setSelectedBuilding(bId);
        this.callbacks.onSelectBuilding?.(bId);
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
      const dx = (moveIsoX * 0.7071 + moveIsoY * 0.7071) * speed;
      const dz = (-moveIsoX * 0.7071 + moveIsoY * 0.7071) * speed;
      this.target.x = Math.max(40, Math.min(960, this.target.x + dx));
      this.target.z = Math.max(40, Math.min(960, this.target.z + dz));
      this.updateCameraTransform();
    }

    this.roadBuilder.updateTraffic(elapsed);
    this.lotGenerator.updateAnimations(elapsed);
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
