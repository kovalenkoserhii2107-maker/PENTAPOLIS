/**
 * Crisp TheoTown-Inspired Procedural Building & RCI Lot Generator (`LotGenerator.ts`).
 *
 * Uses `pickBuildingVisual()` from `@pentapolis/shared-sim` so every placed building renders
 * deterministically from the 140,580-look catalog, plus animated yellow tower cranes on active
 * or stalled 10%/90% co-invested factory sites, timed upgrades, and developer zone sites
 * (frozen orange cranes where developers ran out of building materials).
 */
import * as THREE from "three";
import {
  pickBuildingVisual,
  type BuildingDto,
  type MasterCatalogs,
  type SectorId,
  type ZoneDto,
  type ZoneSiteStatusDto,
} from "@pentapolis/shared-sim";

function createCrispFacadeTexture(wallHex: string, accentHex: string, floors: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = wallHex;
  ctx.fillRect(0, 0, 64, 64);

  // Subtle horizontal floor bands + crisp lit/unlit pixel windows
  const rows = Math.max(2, Math.min(12, floors));
  const rowH = Math.floor(56 / rows);
  ctx.fillStyle = accentHex;
  ctx.fillRect(0, 0, 64, 4);
  ctx.fillRect(0, 60, 64, 4);

  for (let r = 0; r < rows; r++) {
    const wy = 6 + r * rowH;
    for (let c = 0; c < 6; c++) {
      const wx = 5 + c * 10;
      const lit = (r * 7 + c * 13) % 5 !== 0;
      ctx.fillStyle = lit ? "#dbeafe" : "#1e293b";
      ctx.fillRect(wx, wy, 5, Math.max(2, rowH - 3));
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class LotGenerator {
  public readonly group = new THREE.Group();
  private readonly cranes: { boom: THREE.Object3D; stalled: boolean }[] = [];
  private readonly textureCache = new Map<string, THREE.CanvasTexture>();

  private getFacadeTexture(wallHex: string, accentHex: string, floors: number): THREE.CanvasTexture {
    const key = `${wallHex}|${accentHex}|${Math.min(12, floors)}`;
    const hit = this.textureCache.get(key);
    if (hit) return hit;
    const tex = createCrispFacadeTexture(wallHex, accentHex, floors);
    this.textureCache.set(key, tex);
    return tex;
  }

  public rebuild(
    buildings: readonly BuildingDto[],
    zones: readonly ZoneDto[],
    catalogs: MasterCatalogs,
    selectedBuildingId: string | null,
    zoneSites: ReadonlyMap<string, ZoneSiteStatusDto> = new Map()
  ): void {
    while (this.group.children.length > 0) {
      const child = this.group.children.pop()!;
      child.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
    }
    this.cranes.length = 0;

    // 1. Render RCI Zoned Lots & private developer subdivisions
    for (const z of zones) {
      const padGeo = new THREE.BoxGeometry(z.width, 0.08, z.depth);
      const zoneColor = z.zoneKind.startsWith("RES-")
        ? 0x16a34a
        : z.zoneKind.startsWith("COM-")
          ? 0x2563eb
          : 0x9333ea;
      const padMat = new THREE.MeshLambertMaterial({
        color: zoneColor,
        transparent: true,
        opacity: 0.35,
      });
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.position.set(z.x + z.width * 0.5, 0.06, z.y + z.depth * 0.5);
      this.group.add(pad);

      // Subdivide occupied cells into crisp procedural houses / mid-rises / towers
      const step = z.zoneKind === "RES-01" ? 3 : 4;
      const maxCellsX = Math.max(1, Math.floor(z.width / step));
      const maxCellsZ = Math.max(1, Math.floor(z.depth / step));
      const totalCells = maxCellsX * maxCellsZ;
      const builtCount = Math.round(totalCells * z.occupancyRatio);

      const catEntry = catalogs.buildingsById.get(z.zoneKind);
      let idx = 0;
      for (let gz = 0; gz < maxCellsZ; gz++) {
        for (let gx = 0; gx < maxCellsX; gx++) {
          if (idx >= builtCount) break;
          idx += 1;
          const lotId = `${z.id}-${gx}-${gz}`;
          const vis = catEntry
            ? pickBuildingVisual(lotId, catEntry, catalogs.visuals, z.sectorId, "M")
            : null;
          const floors =
            z.zoneKind === "RES-03" || z.zoneKind === "OFF-02"
              ? 12 + ((gx + gz) % 6)
              : z.zoneKind === "RES-02" || z.zoneKind === "COM-02" || z.zoneKind === "OFF-01"
                ? 5 + ((gx + gz) % 3)
                : 2;
          const h = floors * 0.65;
          const bw = step - 0.7;
          const bd = step - 0.7;
          const tex = this.getFacadeTexture(
            vis?.wallHex ?? "#cbd5e1",
            vis?.accentHex ?? "#475569",
            floors
          );
          const bodyGeo = new THREE.BoxGeometry(bw, h, bd);
          const roofMat = new THREE.MeshLambertMaterial({ color: vis?.roofHex ?? "#475569" });
          const wallMat = new THREE.MeshLambertMaterial({ map: tex });
          const box = new THREE.Mesh(bodyGeo, [
            wallMat,
            wallMat,
            roofMat,
            roofMat,
            wallMat,
            wallMat,
          ]);
          box.position.set(
            z.x + gx * step + step * 0.5,
            h * 0.5 + 0.08,
            z.y + gz * step + step * 0.5
          );
          box.castShadow = true;
          box.receiveShadow = true;
          this.group.add(box);
        }
      }

      // Developer site crane until the zone is fully built
      if (z.occupancyRatio < 1) {
        const site = zoneSites.get(z.id);
        const outOfMaterials = site !== undefined && site.fillRatio < 0.05;
        const crane = this.createCrane(9, Math.min(8, z.width * 0.6), outOfMaterials);
        crane.position.set(z.x + 1, 0, z.y + 1);
        this.group.add(crane);
      }
    }

    // 2. Render Placed Catalog Buildings (`EXT`, `PRO`, `CMP`, `ASM`, `ENG`, `CIV`, `MEG`, etc.)
    for (const b of buildings) {
      const entry = catalogs.buildingsById.get(b.catalogId);
      const secId: SectorId = b.sectorId === "core" ? 5 : b.sectorId;
      const vis = entry
        ? pickBuildingVisual(b.id, entry, catalogs.visuals, secId, "M")
        : null;

      const cx = b.tileX + b.width * 0.5;
      const cz = b.tileY + b.depth * 0.5;
      const underConstruction = b.stalledAwaitingPrivate || b.constructionProgress < 1;
      const upgrading = !!b.upgradeTargetLevel;

      const baseFloors = vis?.floors ?? 4;
      const fullHeight = Math.max(2.2, Math.min(22, baseFloors * 0.75 + (b.level - 1) * 1.1));
      const curHeight = underConstruction
        ? Math.max(1.1, fullHeight * Math.max(0.25, b.constructionProgress))
        : fullHeight;

      const buildingContainer = new THREE.Group();
      buildingContainer.position.set(cx, 0, cz);
      buildingContainer.rotation.y = (-b.orientationDeg * Math.PI) / 180;
      buildingContainer.userData = { buildingId: b.id };

      // Concrete foundation pad
      const padGeo = new THREE.BoxGeometry(b.width, 0.2, b.depth);
      const padMat = new THREE.MeshLambertMaterial({
        color: b.id === selectedBuildingId ? 0x38bdf8 : 0x64748b,
      });
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.position.y = 0.1;
      pad.userData = { buildingId: b.id };
      buildingContainer.add(pad);

      // Main architectural mass
      const bw = Math.max(1.4, b.width * 0.82);
      const bd = Math.max(1.4, b.depth * 0.82);
      const tex = this.getFacadeTexture(
        vis?.wallHex ?? "#d6d3d1",
        vis?.accentHex ?? "#f59e0b",
        baseFloors + b.level
      );
      const wallMat = new THREE.MeshLambertMaterial({ map: tex });
      const roofMat = new THREE.MeshLambertMaterial({ color: vis?.roofHex ?? "#334155" });
      const bodyGeo = new THREE.BoxGeometry(bw, curHeight, bd);
      const body = new THREE.Mesh(bodyGeo, [
        wallMat,
        wallMat,
        roofMat,
        roofMat,
        wallMat,
        wallMat,
      ]);
      body.position.y = curHeight * 0.5 + 0.2;
      body.castShadow = true;
      body.receiveShadow = true;
      body.userData = { buildingId: b.id };
      buildingContainer.add(body);

      // Industrial smokestacks / cooling towers for `EXT`, `PRO`, `ENG`
      if (
        !underConstruction &&
        entry &&
        (entry.prefix === "PRO" || entry.prefix === "ENG" || entry.prefix === "EXT")
      ) {
        const stackGeo = new THREE.CylinderGeometry(0.45, 0.65, curHeight * 0.75, 8);
        const stackMat = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });
        const stack = new THREE.Mesh(stackGeo, stackMat);
        stack.position.set(bw * 0.28, curHeight + curHeight * 0.32, -bd * 0.25);
        stack.castShadow = true;
        stack.userData = { buildingId: b.id };
        buildingContainer.add(stack);
      }

      // Yellow Tower Crane for active construction, a timed upgrade, or a stalled 10%/90% factory
      if (underConstruction || upgrading) {
        const crane = this.createCrane(curHeight + 4.5, Math.max(4.5, bw * 0.85), b.stalledAwaitingPrivate);
        crane.position.set(-bw * 0.35, 0.2, -bd * 0.35);
        buildingContainer.add(crane);
      }

      this.group.add(buildingContainer);
    }
  }

  /** Tower crane (mast + slewing jib); stalled cranes are orange and do not slew. */
  private createCrane(mastHeight: number, jibLength: number, stalled: boolean): THREE.Group {
    const craneMat = new THREE.MeshLambertMaterial({ color: stalled ? 0xf59e0b : 0xfacc15 });
    const crane = new THREE.Group();
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.45, mastHeight, 0.45), craneMat);
    mast.position.y = mastHeight * 0.5;
    crane.add(mast);
    const boomPivot = new THREE.Group();
    boomPivot.position.y = mastHeight;
    const jib = new THREE.Mesh(new THREE.BoxGeometry(jibLength, 0.32, 0.32), craneMat.clone());
    jib.position.x = Math.max(1.5, jibLength * 0.35);
    boomPivot.add(jib);
    crane.add(boomPivot);
    this.cranes.push({ boom: boomPivot, stalled });
    return crane;
  }

  public updateAnimations(elapsedSeconds: number): void {
    for (let i = 0; i < this.cranes.length; i++) {
      const c = this.cranes[i]!;
      if (!c.stalled) {
        c.boom.rotation.y = Math.sin(elapsedSeconds * 0.8 + i) * 0.9;
      }
    }
  }
}
