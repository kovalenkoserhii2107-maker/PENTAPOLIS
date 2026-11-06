/**
 * Live 60 FPS Composite 3D Traffic & Emergency Fleet Renderer (`TrafficRenderer.ts`).
 *
 * Keeps a single `THREE.InstancedMesh` per `BodyClass` (`car`, `truck`, `bus`, `metro`, `emergency` =
 * 5 draw calls total for the entire peninsula), using composite procedural `THREE.BufferGeometry`
 * with vertex `color` + `aTintMask` attributes so `instanceColor` paints the bodywork while wheels
 * remain dark graphite, glazing stays sky-blue, lights glow crisp white/red, and `emergency`
 * roof beacons flash alternating red-blue at 60 FPS.
 */
import * as THREE from "three";
import type { TrafficStateDto, VehicleAgentDto } from "@pentapolis/shared-sim";

export type BodyClass = "car" | "truck" | "bus" | "metro" | "emergency";

const BODY_CLASSES: readonly BodyClass[] = ["car", "truck", "bus", "metro", "emergency"];

const BODY_Y: Readonly<Record<BodyClass, number>> = {
  car: 0.22,
  truck: 0.24,
  bus: 0.24,
  metro: 0.3,
  emergency: 0.23,
};

const LANE_OFFSET: Readonly<Record<BodyClass, number>> = {
  car: 0.38,
  truck: 0.45,
  bus: 0.45,
  metro: 0,
  emergency: 0.36,
};

const EMERGENCY_VEHICLE_IDS = new Set([
  "MUN-01",
  "MUN-02",
  "MUN-03",
  "MUN-04",
  "MUN-05",
  "MUN-09",
]);

function bodyClassOf(v: VehicleAgentDto): BodyClass {
  const roleStr = v.role as string;
  if (roleStr === "metro") return "metro";
  if (roleStr === "emergency") return "emergency";
  if (roleStr === "bus") return "bus";
  if (roleStr === "freight") return "truck";
  if (roleStr === "service") {
    if (EMERGENCY_VEHICLE_IDS.has(v.vehicleTypeId)) return "emergency";
    return v.vehicleTypeId === "MUN-06" || v.vehicleTypeId === "MUN-07" || v.vehicleTypeId === "MUN-08"
      ? "truck"
      : "car";
  }
  return "car";
}

interface BoxPartSpec {
  /** Dimensions along `[forward X, up Y, lateral Z]`. */
  readonly size: readonly [number, number, number];
  /** Local center `[x, y, z]` (`y = 0` is wheel contact plane). */
  readonly pos: readonly [number, number, number];
  /** Pitch around Z in radians (e.g. sloped windshield / spoiler). */
  readonly rotZ?: number;
  /** Base RGB `[0..1]`. */
  readonly color: readonly [number, number, number];
  /** `1` = tinted by `instanceColor`; `0` = fixed vertex color; `2` = red flasher; `3` = blue flasher. */
  readonly tintMask: number;
}

const COL_PAINT: readonly [number, number, number] = [1.0, 1.0, 1.0];
const COL_PAINT_SHADE: readonly [number, number, number] = [0.86, 0.88, 0.9];
const COL_WHEEL: readonly [number, number, number] = [0.13, 0.15, 0.18];
const COL_CHASSIS: readonly [number, number, number] = [0.22, 0.25, 0.3];
const COL_GLASS: readonly [number, number, number] = [0.62, 0.85, 0.98];
const COL_METRO_GLASS: readonly [number, number, number] = [0.98, 0.94, 0.65];
const COL_SILVER: readonly [number, number, number] = [0.82, 0.86, 0.9];
const COL_HEADLIGHT: readonly [number, number, number] = [1.0, 0.97, 0.78];
const COL_TAILLIGHT: readonly [number, number, number] = [0.95, 0.16, 0.16];
const COL_ROUTE_SIGN: readonly [number, number, number] = [0.98, 0.78, 0.15];
const COL_BEACON_RED: readonly [number, number, number] = [1.0, 0.15, 0.18];
const COL_BEACON_BLUE: readonly [number, number, number] = [0.15, 0.55, 1.0];

function mergeBoxParts(parts: readonly BoxPartSpec[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const tintMasks: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  for (const part of parts) {
    const box = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
    if (part.rotZ) box.rotateZ(part.rotZ);
    box.translate(part.pos[0], part.pos[1], part.pos[2]);

    const posAttr = box.getAttribute("position") as THREE.BufferAttribute;
    const normAttr = box.getAttribute("normal") as THREE.BufferAttribute;
    const idxAttr = box.getIndex()!;

    for (let i = 0; i < posAttr.count; i++) {
      positions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      normals.push(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
      colors.push(part.color[0], part.color[1], part.color[2]);
      tintMasks.push(part.tintMask);
    }
    for (let i = 0; i < idxAttr.count; i++) {
      indices.push(idxAttr.getX(i) + vertexOffset);
    }
    vertexOffset += posAttr.count;
    box.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  merged.setAttribute("aTintMask", new THREE.Float32BufferAttribute(tintMasks, 1));
  merged.setIndex(indices);
  merged.computeBoundingSphere();
  return merged;
}

function addWheelPair(
  parts: BoxPartSpec[],
  axleX: number,
  halfTrackZ: number,
  wheelRadius = 0.13,
  wheelWidth = 0.1
): void {
  const d = wheelRadius * 2;
  for (const side of [-1, 1]) {
    parts.push({
      size: [d, d, wheelWidth],
      pos: [axleX, wheelRadius, side * halfTrackZ],
      color: COL_WHEEL,
      tintMask: 0,
    });
  }
}

function buildCompositeVehicleGeometry(body: BodyClass): THREE.BufferGeometry {
  const parts: BoxPartSpec[] = [];

  if (body === "car") {
    // Lower pontoon + set-back cabin + sloped front windshield + 4 wheels + lights
    parts.push(
      { size: [1.24, 0.24, 0.62], pos: [0, 0.21, 0], color: COL_PAINT, tintMask: 1 },
      { size: [0.64, 0.22, 0.54], pos: [-0.08, 0.42, 0], color: COL_PAINT, tintMask: 1 },
      // Sloped front windshield & rear window
      { size: [0.22, 0.19, 0.5], pos: [0.23, 0.4, 0], rotZ: -0.45, color: COL_GLASS, tintMask: 0 },
      { size: [0.48, 0.15, 0.56], pos: [-0.08, 0.41, 0], color: COL_GLASS, tintMask: 0 },
      // Front headlights (+X) & rear red taillights (-X)
      { size: [0.05, 0.08, 0.13], pos: [0.62, 0.23, 0.2], color: COL_HEADLIGHT, tintMask: 0 },
      { size: [0.05, 0.08, 0.13], pos: [0.62, 0.23, -0.2], color: COL_HEADLIGHT, tintMask: 0 },
      { size: [0.05, 0.08, 0.14], pos: [-0.62, 0.24, 0.2], color: COL_TAILLIGHT, tintMask: 0 },
      { size: [0.05, 0.08, 0.14], pos: [-0.62, 0.24, -0.2], color: COL_TAILLIGHT, tintMask: 0 }
    );
    addWheelPair(parts, 0.37, 0.3, 0.12, 0.09);
    addWheelPair(parts, -0.37, 0.3, 0.12, 0.09);
    return mergeBoxParts(parts);
  }

  if (body === "truck") {
    // Semi-tractor cab w/ roof wind deflector + fifth-wheel coupling + long trailer + 6 wheel pairs
    parts.push(
      // Chassis & fifth-wheel coupling frame
      { size: [2.42, 0.12, 0.56], pos: [-0.04, 0.22, 0], color: COL_CHASSIS, tintMask: 0 },
      // Tall tractor cab (+X) + aerodynamic roof spoiler
      { size: [0.68, 0.66, 0.8], pos: [0.88, 0.56, 0], color: COL_PAINT, tintMask: 1 },
      { size: [0.34, 0.18, 0.76], pos: [0.8, 0.95, 0], rotZ: -0.35, color: COL_PAINT_SHADE, tintMask: 1 },
      { size: [0.1, 0.26, 0.72], pos: [1.2, 0.66, 0], color: COL_GLASS, tintMask: 0 },
      // Long container semi-trailer (-X)
      { size: [1.62, 0.82, 0.84], pos: [-0.42, 0.68, 0], color: COL_PAINT_SHADE, tintMask: 1 },
      // Lights
      { size: [0.06, 0.1, 0.16], pos: [1.22, 0.34, 0.26], color: COL_HEADLIGHT, tintMask: 0 },
      { size: [0.06, 0.1, 0.16], pos: [1.22, 0.34, -0.26], color: COL_HEADLIGHT, tintMask: 0 },
      { size: [0.06, 0.1, 0.2], pos: [-1.23, 0.34, 0.28], color: COL_TAILLIGHT, tintMask: 0 },
      { size: [0.06, 0.1, 0.2], pos: [-1.23, 0.34, -0.28], color: COL_TAILLIGHT, tintMask: 0 }
    );
    for (const axleX of [0.95, 0.38, 0.08, -0.58, -0.86, -1.1]) {
      addWheelPair(parts, axleX, 0.39, 0.15, 0.11);
    }
    return mergeBoxParts(parts);
  }

  if (body === "bus") {
    // Licensed City Bus (`PT-02`): low-floor body + panoramic side glazing + amber route board + roof AC pod
    parts.push(
      { size: [2.56, 0.42, 0.84], pos: [0, 0.34, 0], color: COL_PAINT, tintMask: 1 },
      { size: [2.52, 0.14, 0.84], pos: [0, 0.88, 0], color: COL_PAINT, tintMask: 1 },
      // Panoramic side & front glazing band
      { size: [2.46, 0.32, 0.86], pos: [0.02, 0.66, 0], color: COL_GLASS, tintMask: 0 },
      // Front illuminated route sign board
      { size: [0.08, 0.13, 0.56], pos: [1.27, 0.87, 0], color: COL_ROUTE_SIGN, tintMask: 0 },
      // Roof air-conditioning unit
      { size: [0.95, 0.14, 0.58], pos: [-0.15, 1.01, 0], color: COL_SILVER, tintMask: 0 },
      // Headlights & taillights
      { size: [0.06, 0.09, 0.16], pos: [1.28, 0.28, 0.28], color: COL_HEADLIGHT, tintMask: 0 },
      { size: [0.06, 0.09, 0.16], pos: [1.28, 0.28, -0.28], color: COL_HEADLIGHT, tintMask: 0 },
      { size: [0.06, 0.12, 0.16], pos: [-1.28, 0.34, 0.28], color: COL_TAILLIGHT, tintMask: 0 },
      { size: [0.06, 0.12, 0.16], pos: [-1.28, 0.34, -0.28], color: COL_TAILLIGHT, tintMask: 0 }
    );
    addWheelPair(parts, 0.78, 0.4, 0.15, 0.11);
    addWheelPair(parts, -0.62, 0.4, 0.15, 0.11);
    addWheelPair(parts, -0.94, 0.4, 0.15, 0.11);
    return mergeBoxParts(parts);
  }

  if (body === "metro") {
    // 3-car coupled underground metro train with silver roof & lit passenger windows
    const carLen = 1.62;
    const spacing = 1.78;
    for (const cIdx of [-1, 0, 1]) {
      const cx = cIdx * spacing;
      parts.push(
        { size: [carLen, 0.36, 0.92], pos: [cx, 0.28, 0], color: COL_PAINT, tintMask: 1 },
        { size: [carLen - 0.08, 0.26, 0.94], pos: [cx, 0.56, 0], color: COL_METRO_GLASS, tintMask: 0 },
        { size: [carLen, 0.14, 0.9], pos: [cx, 0.76, 0], color: COL_SILVER, tintMask: 0 }
      );
    }
    // Coupled accordion gangways
    for (const gx of [-spacing * 0.5, spacing * 0.5]) {
      parts.push({ size: [0.22, 0.62, 0.78], pos: [gx, 0.44, 0], color: COL_CHASSIS, tintMask: 0 });
    }
    // Twin headlights at both cab ends (metro shuttles bidirectionally)
    for (const endSign of [-1, 1]) {
      const ex = endSign * (spacing + carLen * 0.5 + 0.02);
      parts.push(
        { size: [0.06, 0.1, 0.18], pos: [ex, 0.3, 0.26], color: COL_HEADLIGHT, tintMask: 0 },
        { size: [0.06, 0.1, 0.18], pos: [ex, 0.3, -0.26], color: COL_HEADLIGHT, tintMask: 0 }
      );
    }
    return mergeBoxParts(parts);
  }

  // `emergency` — Police / Fire / Ambulance responder with flashing red-blue roof lightbar
  parts.push(
    { size: [1.56, 0.32, 0.72], pos: [0, 0.27, 0], color: COL_PAINT, tintMask: 1 },
    { size: [1.05, 0.28, 0.66], pos: [-0.14, 0.55, 0], color: COL_SILVER, tintMask: 0 },
    { size: [0.24, 0.24, 0.62], pos: [0.38, 0.53, 0], rotZ: -0.38, color: COL_GLASS, tintMask: 0 },
    // White emergency stripe along flanks
    { size: [1.58, 0.08, 0.74], pos: [0, 0.32, 0], color: COL_SILVER, tintMask: 0 },
    // Roof emergency lightbar: left crimson flasher (`tintMask = 2`) & right blue flasher (`tintMask = 3`)
    { size: [0.18, 0.11, 0.26], pos: [0.16, 0.74, -0.15], color: COL_BEACON_RED, tintMask: 2 },
    { size: [0.18, 0.11, 0.26], pos: [0.16, 0.74, 0.15], color: COL_BEACON_BLUE, tintMask: 3 },
    // Headlights & taillights
    { size: [0.06, 0.09, 0.15], pos: [0.78, 0.26, 0.22], color: COL_HEADLIGHT, tintMask: 0 },
    { size: [0.06, 0.09, 0.15], pos: [0.78, 0.26, -0.22], color: COL_HEADLIGHT, tintMask: 0 },
    { size: [0.06, 0.1, 0.15], pos: [-0.78, 0.28, 0.22], color: COL_TAILLIGHT, tintMask: 0 },
    { size: [0.06, 0.1, 0.15], pos: [-0.78, 0.28, -0.22], color: COL_TAILLIGHT, tintMask: 0 }
  );
  addWheelPair(parts, 0.46, 0.34, 0.14, 0.1);
  addWheelPair(parts, -0.46, 0.34, 0.14, 0.1);
  return mergeBoxParts(parts);
}

function createVehicleMaterial(beaconUniform: { value: number }): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBeaconTime = beaconUniform;
    shader.vertexShader =
      `attribute float aTintMask;\nuniform float uBeaconTime;\n` +
      shader.vertexShader.replace(
        "vColor.xyz *= instanceColor.xyz;",
        `if ( aTintMask > 1.5 ) {
          float flash = aTintMask < 2.5
            ? step( 0.0, sin( uBeaconTime * 16.0 ) )
            : step( 0.0, -sin( uBeaconTime * 16.0 ) );
          vColor.xyz = mix( color.xyz * 0.25, color.xyz * 1.45, flash );
        } else {
          vColor.xyz = mix( color.xyz, color.xyz * instanceColor.xyz, aTintMask );
        }`
      );
  };
  return mat;
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
  private readonly beaconTimeUniform = { value: 0 };
  private selectedId: string | null = null;
  private undergroundView = false;

  constructor() {
    const ringGeo = new THREE.RingGeometry(1.6, 2.2, 24);
    ringGeo.rotateX(-Math.PI / 2);
    this.highlight = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0xfacc15,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthTest: false,
      })
    );
    this.highlight.renderOrder = 10;
    this.highlight.visible = false;
    this.group.add(this.highlight);
  }

  public setTraffic(state: TrafficStateDto): void {
    const counts: Record<BodyClass, number> = {
      car: 0,
      truck: 0,
      bus: 0,
      metro: 0,
      emergency: 0,
    };
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
      const v: AnimatedVehicle = {
        dto,
        body,
        slot: counts[body]++,
        cumulative,
        length,
        position: new THREE.Vector3(),
      };
      next.push(v);
      this.byId.set(dto.id, v);
    }

    for (const body of BODY_CLASSES) {
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
    const mesh = new THREE.InstancedMesh(
      buildCompositeVehicleGeometry(body),
      createVehicleMaterial(this.beaconTimeUniform),
      capacity
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, this.color.setHex(0xffffff));
    mesh.frustumCulled = false;
    mesh.castShadow = body !== "metro";
    mesh.receiveShadow = body !== "metro";
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
    this.beaconTimeUniform.value = elapsedSeconds;

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
