/**
 * Procedural 90° & 45° Transport / Utility Network Mesh Builder + Instanced Traffic (`60 FPS`).
 *
 * Renders:
 * - Orthogonal (`0°/90°`) and diagonal (`45°`) road ribbons (`street_2lane` .. `heavy_bypass`),
 *   heavy rail (`rail`), pipelines (`pipeline`), HV lines (`hv_power`), and underground guides (`metro_tunnel`);
 * - River bridges (`hasBridge === true`) & flyovers (`isFlyover === true`) elevated at `Z = +1` (`y = 1.6`) with piers;
 * - Live instanced vehicles (`THREE.InstancedMesh`) moving along road & rail segments.
 */
import * as THREE from "three";
import type { NetworkKind, NetworkSegmentDto } from "@pentapolis/shared-sim";

const WIDTH_BY_KIND: Readonly<Record<NetworkKind, number>> = {
  street_2lane: 1.4,
  avenue_4lane: 2.2,
  express_6lane: 3.0,
  heavy_bypass: 2.8,
  rail: 1.3,
  pipeline: 0.75,
  hv_power: 0.45,
  metro_tunnel: 1.2,
};

const COLOR_BY_KIND: Readonly<Record<NetworkKind, number>> = {
  street_2lane: 0x3b4252,
  avenue_4lane: 0x2f3644,
  express_6lane: 0x242a36,
  heavy_bypass: 0x4b443b,
  rail: 0x6b5344,
  pipeline: 0xd97706,
  hv_power: 0x38bdf8,
  metro_tunnel: 0x818cf8,
};

interface ActiveLanePath {
  readonly fromX: number;
  readonly fromZ: number;
  readonly toX: number;
  readonly toZ: number;
  readonly y: number;
  readonly speed: number;
  readonly color: THREE.Color;
}

export class RoadMeshBuilder {
  public readonly group = new THREE.Group();
  private readonly segmentsGroup = new THREE.Group();
  private vehicleInstanced: THREE.InstancedMesh | null = null;
  private activePaths: ActiveLanePath[] = [];
  private readonly dummy = new THREE.Object3D();

  constructor() {
    this.group.add(this.segmentsGroup);
  }

  public rebuild(segments: readonly NetworkSegmentDto[]): void {
    // Clear previous segment meshes cleanly
    while (this.segmentsGroup.children.length > 0) {
      const child = this.segmentsGroup.children.pop()!;
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

    const lanePaths: ActiveLanePath[] = [];
    const pierGeo = new THREE.BoxGeometry(0.65, 1.6, 0.65);
    const pierMat = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });

    for (const seg of segments) {
      const dx = seg.toX - seg.fromX;
      const dz = seg.toY - seg.fromY;
      const length = Math.hypot(dx, dz);
      if (length < 0.1) continue;

      const elevated = seg.hasBridge || seg.isFlyover;
      const yDeck =
        seg.kind === "metro_tunnel"
          ? 0.04
          : elevated
            ? 1.55
            : seg.kind === "hv_power"
              ? 2.2
              : seg.kind === "pipeline"
                ? 0.45
                : 0.14;

      const width = WIDTH_BY_KIND[seg.kind] ?? 1.4;
      let baseColor = COLOR_BY_KIND[seg.kind] ?? 0x3b4252;
      if (seg.healthPercent < 40) {
        baseColor = 0x7f1d1d; // Severe road damage alert tint
      } else if (seg.healthPercent < 75) {
        baseColor = 0x57534e; // Worn asphalt
      }

      const deckHeight = elevated ? 0.28 : 0.14;
      const geo = new THREE.BoxGeometry(length + width * 0.35, deckHeight, width);
      const mat = new THREE.MeshLambertMaterial({
        color: baseColor,
        transparent: seg.kind === "metro_tunnel",
        opacity: seg.kind === "metro_tunnel" ? 0.45 : 1.0,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(seg.fromX + dx * 0.5, yDeck, seg.fromY + dz * 0.5);
      mesh.rotation.y = -Math.atan2(dz, dx);
      mesh.castShadow = elevated;
      mesh.receiveShadow = true;
      this.segmentsGroup.add(mesh);

      // Center lane stripe for multi-lane roads
      if (
        seg.kind === "avenue_4lane" ||
        seg.kind === "express_6lane" ||
        seg.kind === "street_2lane"
      ) {
        const stripeGeo = new THREE.BoxGeometry(length, 0.03, 0.12);
        const stripeMat = new THREE.MeshBasicMaterial({
          color: seg.hasBridge ? 0xfacc15 : 0xe2e8f0,
        });
        const stripe = new THREE.Mesh(stripeGeo, stripeMat);
        stripe.position.set(seg.fromX + dx * 0.5, yDeck + deckHeight * 0.52, seg.fromY + dz * 0.5);
        stripe.rotation.y = -Math.atan2(dz, dx);
        this.segmentsGroup.add(stripe);
      }

      // Bridge / flyover support piers (`Z = +1`)
      if (elevated) {
        const pierCount = Math.max(2, Math.floor(length / 8));
        for (let i = 1; i < pierCount; i++) {
          const t = i / pierCount;
          const pier = new THREE.Mesh(pierGeo.clone(), pierMat.clone());
          pier.position.set(seg.fromX + dx * t, 0.78, seg.fromY + dz * t);
          this.segmentsGroup.add(pier);
        }
      }

      // Add moving traffic lanes for surface roads & rail (zero marshrutkas: sedans, municipal buses, freight trucks, trains)
      if (
        seg.kind === "street_2lane" ||
        seg.kind === "avenue_4lane" ||
        seg.kind === "express_6lane" ||
        seg.kind === "heavy_bypass" ||
        seg.kind === "rail"
      ) {
        const palette =
          seg.kind === "rail"
            ? [0xef4444, 0x2563eb]
            : seg.kind === "heavy_bypass"
              ? [0xf59e0b, 0xd97706, 0x94a3b8]
              : [0x38bdf8, 0xf8fafc, 0xfacc15, 0x22c55e, 0xf97316];
        const countOnSeg = Math.min(4, Math.max(1, Math.floor(length / 18)));
        for (let c = 0; c < countOnSeg; c++) {
          lanePaths.push({
            fromX: seg.fromX,
            fromZ: seg.fromY,
            toX: seg.toX,
            toZ: seg.toY,
            y: yDeck + deckHeight * 0.5 + 0.25,
            speed: seg.kind === "express_6lane" ? 0.26 : seg.kind === "rail" ? 0.22 : 0.16,
            color: new THREE.Color(palette[(c + Math.round(seg.fromX)) % palette.length]!),
          });
        }
      }
    }

    pierGeo.dispose();
    pierMat.dispose();
    this.rebuildVehicles(lanePaths.slice(0, 360));
  }

  private rebuildVehicles(paths: ActiveLanePath[]): void {
    if (this.vehicleInstanced) {
      this.group.remove(this.vehicleInstanced);
      this.vehicleInstanced.geometry.dispose();
      if (Array.isArray(this.vehicleInstanced.material)) {
        this.vehicleInstanced.material.forEach((m) => m.dispose());
      } else {
        this.vehicleInstanced.material.dispose();
      }
      this.vehicleInstanced = null;
    }

    this.activePaths = paths;
    if (paths.length === 0) return;

    const carGeo = new THREE.BoxGeometry(1.15, 0.5, 0.65);
    const carMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const inst = new THREE.InstancedMesh(carGeo, carMat, paths.length);
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < paths.length; i++) {
      inst.setColorAt(i, paths[i]!.color);
    }
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;

    this.vehicleInstanced = inst;
    this.group.add(inst);
  }

  public updateTraffic(elapsedSeconds: number): void {
    if (!this.vehicleInstanced || this.activePaths.length === 0) return;
    for (let i = 0; i < this.activePaths.length; i++) {
      const p = this.activePaths[i]!;
      const phase = ((elapsedSeconds * p.speed + i * 0.31) % 1 + 1) % 1;
      const forward = i % 2 === 0 ? phase : 1 - phase;
      const x = p.fromX + (p.toX - p.fromX) * forward;
      const z = p.fromZ + (p.toZ - p.fromZ) * forward;
      const angle = -Math.atan2(p.toZ - p.fromZ, p.toX - p.fromX) + (i % 2 === 0 ? 0 : Math.PI);

      this.dummy.position.set(x, p.y, z);
      this.dummy.rotation.set(0, angle, 0);
      this.dummy.updateMatrix();
      this.vehicleInstanced.setMatrixAt(i, this.dummy.matrix);
    }
    this.vehicleInstanced.instanceMatrix.needsUpdate = true;
  }
}
