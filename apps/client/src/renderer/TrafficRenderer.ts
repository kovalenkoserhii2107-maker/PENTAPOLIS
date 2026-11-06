/**
 * Live 60 FPS Traffic Renderer (Sprint 5, GDD §7.1, §8.1).
 *
 * Draws the server's sampled vehicles (`TrafficStateDto.vehicles`) with one `THREE.InstancedMesh`
 * per body class (cars, trucks, buses, metro trains), so the whole fleet costs 4 draw calls.
 * Each vehicle shuttles along its routed polyline at its health- and congestion-reduced speed,
 * keeping to the right-hand lane. Picking is screen-space (nearest vehicle to the cursor), which
 * stays usable at any zoom where vehicles are only a few pixels long.
 */
import * as THREE from "three";
import type { TrafficStateDto, VehicleAgentDto } from "@pentapolis/shared-sim";

type BodyClass = "car" | "truck" | "bus" | "metro";

const BODY_GEOMETRY: Readonly<Record<BodyClass, readonly [number, number, number]>> = {
  car: [1.15, 0.5, 0.62],
  truck: [2.3, 0.95, 0.85],
  bus: [2.5, 0.95, 0.85],
  metro: [5.2, 0.75, 0.95],
};

const BODY_Y: Readonly<Record<BodyClass, number>> = { car: 0.45, truck: 0.68, bus: 0.68, metro: 0.5 };
const LANE_OFFSET: Readonly<Record<BodyClass, number>> = { car: 0.38, truck: 0.45, bus: 0.45, metro: 0 };

function bodyClassOf(v: VehicleAgentDto): BodyClass {
  if (v.role === "metro") return "metro";
  if (v.role === "bus") return "bus";
  if (v.role === "freight") return "truck";
  // Fire engines, garbage trucks and utility crews are truck-sized; patrol cars and ambulances are cars
  if (v.role === "service") return v.vehicleTypeId === "MUN-04" || v.vehicleTypeId === "MUN-06" || v.vehicleTypeId === "MUN-09" ? "truck" : "car";
  return "car";
}

interface AnimatedVehicle {
  readonly dto: VehicleAgentDto;
  readonly body: BodyClass;
  readonly slot: number;
  readonly cumulative: Float32Array;
  readonly length: number;
  readonly position: THREE.Vector3;
}

export class TrafficRenderer {
  public readonly group = new THREE.Group();
  private readonly meshes = new Map<BodyClass, THREE.InstancedMesh>();
  private vehicles: AnimatedVehicle[] = [];
  private readonly byId = new Map<string, AnimatedVehicle>();
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private readonly highlight: THREE.Mesh;
  private selectedId: string | null = null;
  private undergroundView = false;

  constructor() {
    const ringGeo = new THREE.RingGeometry(1.6, 2.2, 24);
    ringGeo.rotateX(-Math.PI / 2);
    this.highlight = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false })
    );
    this.highlight.renderOrder = 10;
    this.highlight.visible = false;
    this.group.add(this.highlight);
  }

  public setTraffic(state: TrafficStateDto): void {
    const counts: Record<BodyClass, number> = { car: 0, truck: 0, bus: 0, metro: 0 };
    const next: AnimatedVehicle[] = [];
    this.byId.clear();

    for (const dto of state.vehicles) {
      if (dto.path.length < 4) continue;
      const body = bodyClassOf(dto);
      const nPts = dto.path.length / 2;
      const cumulative = new Float32Array(nPts);
      for (let i = 1; i < nPts; i++) {
        const dx = dto.path[i * 2]! - dto.path[(i - 1) * 2]!;
        const dz = dto.path[i * 2 + 1]! - dto.path[(i - 1) * 2 + 1]!;
        cumulative[i] = cumulative[i - 1]! + Math.hypot(dx, dz);
      }
      const length = cumulative[nPts - 1]!;
      if (length <= 0.01) continue;
      const v: AnimatedVehicle = { dto, body, slot: counts[body]++, cumulative, length, position: new THREE.Vector3() };
      next.push(v);
      this.byId.set(dto.id, v);
    }

    for (const body of Object.keys(BODY_GEOMETRY) as BodyClass[]) {
      this.ensureCapacity(body, counts[body]);
    }
    this.vehicles = next;
    for (const v of next) {
      this.meshes.get(v.body)!.setColorAt(v.slot, this.color.setHex(v.dto.colorHex));
    }
    for (const [body, mesh] of this.meshes) {
      mesh.count = counts[body];
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (this.selectedId && !this.byId.has(this.selectedId)) this.selectedId = null;
    this.applyLayerVisibility();
  }

  private ensureCapacity(body: BodyClass, needed: number): void {
    const existing = this.meshes.get(body);
    if (existing && existing.instanceMatrix.count >= needed) return;
    if (existing) {
      this.group.remove(existing);
      existing.geometry.dispose();
      (existing.material as THREE.Material).dispose();
    }
    const capacity = Math.max(16, Math.ceil(needed * 1.5));
    const [w, h, d] = BODY_GEOMETRY[body];
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      capacity
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, this.color.setHex(0xffffff));
    mesh.frustumCulled = false;
    mesh.castShadow = body !== "metro";
    mesh.count = 0;
    this.meshes.set(body, mesh);
    this.group.add(mesh);
  }

  public setUndergroundView(on: boolean): void {
    this.undergroundView = on;
    this.applyLayerVisibility();
  }

  private applyLayerVisibility(): void {
    for (const [body, mesh] of this.meshes) {
      mesh.visible = body === "metro" ? this.undergroundView : !this.undergroundView;
    }
  }

  public setSelected(vehicleId: string | null): void {
    this.selectedId = vehicleId;
  }

  public getVehiclePosition(vehicleId: string): THREE.Vector3 | null {
    return this.byId.get(vehicleId)?.position ?? null;
  }

  public update(elapsedSeconds: number): void {
    for (const v of this.vehicles) {
      const path = v.dto.path;
      const loop = v.length * 2;
      let s = (v.dto.phase * loop + elapsedSeconds * v.dto.speedTilesPerSec) % loop;
      const forward = s <= v.length;
      if (!forward) s = loop - s;

      // Locate the polyline piece containing distance `s`
      let i = 1;
      while (i < v.cumulative.length - 1 && v.cumulative[i]! < s) i++;
      const s0 = v.cumulative[i - 1]!;
      const pieceLen = Math.max(1e-6, v.cumulative[i]! - s0);
      const t = Math.min(1, Math.max(0, (s - s0) / pieceLen));
      const ax = path[(i - 1) * 2]!;
      const az = path[(i - 1) * 2 + 1]!;
      const bx = path[i * 2]!;
      const bz = path[i * 2 + 1]!;
      let dirX = (bx - ax) / pieceLen;
      let dirZ = (bz - az) / pieceLen;
      if (!forward) {
        dirX = -dirX;
        dirZ = -dirZ;
      }
      // Right-hand traffic: offset to the right of the heading
      const lane = LANE_OFFSET[v.body];
      const x = ax + (bx - ax) * t - dirZ * lane;
      const z = az + (bz - az) * t + dirX * lane;
      v.position.set(x, BODY_Y[v.body], z);

      this.dummy.position.copy(v.position);
      this.dummy.rotation.set(0, -Math.atan2(dirZ, dirX), 0);
      this.dummy.updateMatrix();
      this.meshes.get(v.body)!.setMatrixAt(v.slot, this.dummy.matrix);
    }
    for (const mesh of this.meshes.values()) mesh.instanceMatrix.needsUpdate = true;

    const sel = this.selectedId ? this.byId.get(this.selectedId) : undefined;
    if (sel && (sel.body === "metro") === this.undergroundView) {
      this.highlight.visible = true;
      this.highlight.position.set(sel.position.x, 0.25, sel.position.z);
      const pulse = 1 + 0.15 * Math.sin(elapsedSeconds * 6);
      this.highlight.scale.set(pulse, 1, pulse);
    } else {
      this.highlight.visible = false;
    }
  }

  /** Nearest visible vehicle to a screen point within `maxPixels`, or `null`. */
  public pickNearest(
    clientX: number,
    clientY: number,
    camera: THREE.Camera,
    rect: DOMRect,
    maxPixels = 14
  ): string | null {
    const projected = new THREE.Vector3();
    let best: string | null = null;
    let bestD = maxPixels;
    for (const v of this.vehicles) {
      if ((v.body === "metro") !== this.undergroundView) continue;
      projected.copy(v.position).project(camera);
      const sx = rect.left + ((projected.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - projected.y) / 2) * rect.height;
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d < bestD) {
        bestD = d;
        best = v.dto.id;
      }
    }
    return best;
  }
}
