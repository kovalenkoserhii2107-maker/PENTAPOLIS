/**
 * Procedural 90° & 45° Transport / Utility Network Mesh Builder (`RoadMeshBuilder.ts`).
 *
 * TheoTown Crisp Isometric edition:
 * - Light-grey sidewalks & curbs (`0xcbd5e1`, `roadWidth + 0.55`, `yDeck - 0.02`) beneath `0x334155` asphalt;
 * - Procedural `CanvasTexture` (`RepeatWrapping`) dashed lane lines + double dividers / green boulevard medians;
 * - Intersection node graph (`degree >= 3`) with junction discs, stop lines, 5-stripe zebra crosswalks,
 *   and L-shaped traffic light poles with cycling R/Y/G signal lamps (`updateSignals(elapsedSeconds)`);
 * - `THREE.InstancedMesh` streetlights every 8 tiles along urban streets;
 * - Lattice steel HV pylons every 10 tiles with sagging catenary conductors (`hv_power`);
 * - Orange/steel trunk pipes on concrete saddle piers with red shutoff valves (`pipeline`);
 * - Underground Overlay (`metro_tunnel`) fading surface networks cleanly.
 */
import * as THREE from "three";
import type { NetworkKind, NetworkSegmentDto } from "@pentapolis/shared-sim";

const WIDTH_BY_KIND: Readonly<Record<NetworkKind, number>> = {
  street_2lane: 1.4,
  avenue_4lane: 2.2,
  express_6lane: 3.0,
  heavy_bypass: 2.8,
  rail: 1.3,
  pipeline: 0.56,
  hv_power: 0.45,
  metro_tunnel: 1.2,
};

const URBAN_STREET_KINDS = new Set<NetworkKind>(["street_2lane", "avenue_4lane", "express_6lane"]);
const ROAD_KINDS = new Set<NetworkKind>(["street_2lane", "avenue_4lane", "express_6lane", "heavy_bypass"]);

function createLaneMarkingBaseCanvas(lanes: 4 | 6, asphaltHex: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = asphaltHex;
  ctx.fillRect(0, 0, 64, 64);

  // Subtle asphalt aggregate grain
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  for (let i = 0; i < 40; i++) {
    ctx.fillRect((i * 19) % 64, (i * 37) % 64, 2, 2);
  }

  // Crisp white edge lines
  ctx.fillStyle = "rgba(226, 232, 240, 0.55)";
  ctx.fillRect(0, 2, 64, 2);
  ctx.fillRect(0, 60, 64, 2);

  // Dashed white lane-separation lines along X (`RepeatWrapping` on S)
  ctx.fillStyle = "#f8fafc";
  const yPositions = lanes === 6 ? [12, 21, 43, 52] : [16, 48];
  for (const ly of yPositions) {
    ctx.fillRect(6, ly, 22, 2);
    ctx.fillRect(38, ly, 22, 2);
  }

  return canvas;
}

interface TrafficSignalLampSet {
  readonly red: THREE.MeshBasicMaterial;
  readonly yellow: THREE.MeshBasicMaterial;
  readonly green: THREE.MeshBasicMaterial;
  readonly phaseOffset: number;
}

export class RoadMeshBuilder {
  public readonly group = new THREE.Group();
  private readonly segmentsGroup = new THREE.Group();
  private undergroundView = false;
  private readonly signalSets: TrafficSignalLampSet[] = [];
  private readonly laneCanvas4Good = createLaneMarkingBaseCanvas(4, "#334155");
  private readonly laneCanvas6Good = createLaneMarkingBaseCanvas(6, "#334155");
  private readonly laneCanvas4Worn = createLaneMarkingBaseCanvas(4, "#57534e");
  private readonly laneCanvas6Worn = createLaneMarkingBaseCanvas(6, "#57534e");
  private readonly laneCanvas4Bad = createLaneMarkingBaseCanvas(4, "#7f1d1d");
  private readonly laneCanvas6Bad = createLaneMarkingBaseCanvas(6, "#7f1d1d");

  constructor() {
    this.group.add(this.segmentsGroup);
  }

  public setUndergroundView(on: boolean): void {
    this.undergroundView = on;
    this.applyLayerVisibility();
  }

  private applyLayerVisibility(): void {
    this.segmentsGroup.traverse((obj) => {
      if (obj === this.segmentsGroup) return;
      if (obj.userData.underground) {
        obj.visible = this.undergroundView;
        return;
      }
      if (obj instanceof THREE.InstancedMesh || obj instanceof THREE.Line) {
        obj.visible = !this.undergroundView;
        return;
      }
      if (obj instanceof THREE.Mesh) {
        if (obj.userData.hideUnderground) {
          obj.visible = !this.undergroundView;
          return;
        }
        const mat = obj.material as THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;
        mat.transparent = this.undergroundView;
        mat.opacity = this.undergroundView ? 0.16 : 1;
        mat.depthWrite = !this.undergroundView;
      }
    });
  }

  public rebuild(segments: readonly NetworkSegmentDto[]): void {
    while (this.segmentsGroup.children.length > 0) {
      const child = this.segmentsGroup.children.pop()!;
      child.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.InstancedMesh || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            const lm = m as THREE.MeshLambertMaterial;
            if (lm.map) lm.map.dispose();
            m.dispose();
          }
        }
      });
    }
    this.signalSets.length = 0;

    const nodeMap = new Map<string, NetworkSegmentDto[]>();
    const lampTransforms: { x: number; y: number; z: number; rotY: number }[] = [];

    const addEndpoint = (x: number, y: number, seg: NetworkSegmentDto) => {
      const key = `${Math.round(x)},${Math.round(y)}`;
      let list = nodeMap.get(key);
      if (!list) {
        list = [];
        nodeMap.set(key, list);
      }
      list.push(seg);
    };

    for (const seg of segments) {
      const dx = seg.toX - seg.fromX;
      const dz = seg.toY - seg.fromY;
      const length = Math.hypot(dx, dz);
      if (length < 0.1) continue;

      if (ROAD_KINDS.has(seg.kind) && !seg.isFlyover) {
        addEndpoint(seg.fromX, seg.fromY, seg);
        addEndpoint(seg.toX, seg.toY, seg);
      }

      // 1. High-voltage power transmission lines (`hv_power`): lattice pylons every 10 tiles + sagging wires
      if (seg.kind === "hv_power") {
        this.buildHvPowerSegment(seg, dx, dz, length);
        continue;
      }

      // 2. Trunk oil/gas pipelines (`pipeline`): cylindrical steel/orange pipe + concrete saddle piers + valves
      if (seg.kind === "pipeline") {
        this.buildPipelineSegment(seg, dx, dz, length);
        continue;
      }

      const elevated = seg.hasBridge || seg.isFlyover;
      const yDeck =
        seg.kind === "metro_tunnel"
          ? 0.2
          : elevated
            ? 1.55
            : 0.14;

      const width = WIDTH_BY_KIND[seg.kind] ?? 1.4;
      const isUrbanStreet = URBAN_STREET_KINDS.has(seg.kind);
      const angleY = -Math.atan2(dz, dx);
      const midX = seg.fromX + dx * 0.5;
      const midZ = seg.fromY + dz * 0.5;
      const deckHeight = elevated ? 0.26 : 0.12;

      // 3. Light-grey sidewalk & curb base (`0xcbd5e1`, width `roadWidth + 0.55`, `yDeck - 0.02`)
      if (isUrbanStreet) {
        const swWidth = width + 0.55;
        const swGeo = new THREE.BoxGeometry(length + swWidth * 0.28, deckHeight, swWidth);
        const swMat = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
        const sidewalk = new THREE.Mesh(swGeo, swMat);
        sidewalk.position.set(midX, yDeck - 0.02, midZ);
        sidewalk.rotation.y = angleY;
        sidewalk.receiveShadow = true;
        sidewalk.castShadow = elevated;
        this.segmentsGroup.add(sidewalk);
      }

      // 4. Main road / rail / metro deck
      let asphaltColor =
        seg.kind === "rail"
          ? 0x6b5344
          : seg.kind === "heavy_bypass"
            ? 0x44403c
            : 0x334155;
      if (ROAD_KINDS.has(seg.kind)) {
        if (seg.healthPercent < 40) asphaltColor = 0x7f1d1d;
        else if (seg.healthPercent < 75) asphaltColor = 0x57534e;
      }

      let mat: THREE.Material;
      if (seg.kind === "metro_tunnel") {
        mat = new THREE.MeshBasicMaterial({ color: 0x818cf8 });
      } else if (seg.kind === "avenue_4lane" || seg.kind === "express_6lane") {
        const srcCanvas =
          seg.healthPercent < 40
            ? seg.kind === "express_6lane"
              ? this.laneCanvas6Bad
              : this.laneCanvas4Bad
            : seg.healthPercent < 75
              ? seg.kind === "express_6lane"
                ? this.laneCanvas6Worn
                : this.laneCanvas4Worn
              : seg.kind === "express_6lane"
                ? this.laneCanvas6Good
                : this.laneCanvas4Good;
        const laneTex = new THREE.CanvasTexture(srcCanvas);
        laneTex.wrapS = THREE.RepeatWrapping;
        laneTex.wrapT = THREE.ClampToEdgeWrapping;
        laneTex.magFilter = THREE.NearestFilter;
        laneTex.minFilter = THREE.NearestFilter;
        laneTex.colorSpace = THREE.SRGBColorSpace;
        laneTex.repeat.set(Math.max(1, length / 3.4), 1);
        mat = new THREE.MeshLambertMaterial({ map: laneTex });
      } else {
        mat = new THREE.MeshLambertMaterial({ color: asphaltColor });
      }

      const geo = new THREE.BoxGeometry(length + width * 0.25, deckHeight, width);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.segmentId = seg.id;
      mesh.userData.underground = seg.kind === "metro_tunnel";
      mesh.position.set(midX, yDeck, midZ);
      mesh.rotation.y = angleY;
      mesh.castShadow = elevated;
      mesh.receiveShadow = true;
      this.segmentsGroup.add(mesh);

      // 5. Center dividers / green boulevard median / railway sleepers
      const topY = yDeck + deckHeight * 0.52;
      if (seg.kind === "street_2lane") {
        const stripe = new THREE.Mesh(
          new THREE.BoxGeometry(Math.max(0.2, length - 0.6), 0.025, 0.08),
          new THREE.MeshBasicMaterial({ color: seg.hasBridge ? 0xfacc15 : 0xe2e8f0 })
        );
        stripe.position.set(midX, topY, midZ);
        stripe.rotation.y = angleY;
        this.segmentsGroup.add(stripe);
      } else if (seg.kind === "avenue_4lane") {
        // Double center divider
        for (const zOff of [-0.07, 0.07]) {
          const line = new THREE.Mesh(
            new THREE.BoxGeometry(Math.max(0.2, length - 0.8), 0.028, 0.06),
            new THREE.MeshBasicMaterial({ color: 0xfacc15 })
          );
          const ox = -Math.sin(angleY) * zOff;
          const oz = -Math.cos(angleY) * zOff;
          line.position.set(midX + ox, topY, midZ + oz);
          line.rotation.y = angleY;
          this.segmentsGroup.add(line);
        }
      } else if (seg.kind === "express_6lane") {
        // Narrow raised boulevard island with green turf
        const curbIsland = new THREE.Mesh(
          new THREE.BoxGeometry(Math.max(0.4, length - 1.2), 0.08, 0.34),
          new THREE.MeshLambertMaterial({ color: 0xcbd5e1 })
        );
        curbIsland.position.set(midX, topY + 0.02, midZ);
        curbIsland.rotation.y = angleY;
        this.segmentsGroup.add(curbIsland);

        const greenStrip = new THREE.Mesh(
          new THREE.BoxGeometry(Math.max(0.3, length - 1.5), 0.1, 0.22),
          new THREE.MeshLambertMaterial({ color: 0x16a34a })
        );
        greenStrip.position.set(midX, topY + 0.03, midZ);
        greenStrip.rotation.y = angleY;
        this.segmentsGroup.add(greenStrip);
      } else if (seg.kind === "rail") {
        for (const rOff of [-0.36, 0.36]) {
          const rail = new THREE.Mesh(
            new THREE.BoxGeometry(length, 0.05, 0.08),
            new THREE.MeshLambertMaterial({ color: 0xcbd5e1 })
          );
          const ox = -(dz / length) * rOff;
          const oz = (dx / length) * rOff;
          rail.position.set(midX + ox, topY + 0.01, midZ + oz);
          rail.rotation.y = angleY;
          this.segmentsGroup.add(rail);
        }
      }

      // 6. Bridge / flyover concrete piers (`Z = +1`)
      if (elevated) {
        const pierCount = Math.max(2, Math.floor(length / 8));
        for (let i = 1; i < pierCount; i++) {
          const t = i / pierCount;
          const pier = new THREE.Mesh(
            new THREE.BoxGeometry(0.65, 1.55, 0.65),
            new THREE.MeshLambertMaterial({ color: 0x94a3b8 })
          );
          pier.position.set(seg.fromX + dx * t, 0.78, seg.fromY + dz * t);
          this.segmentsGroup.add(pier);
        }
      }

      // 7. Collect streetlight placements every 8 tiles along urban streets
      if (isUrbanStreet && length >= 4) {
        const ux = dx / length;
        const uz = dz / length;
        const nx = -uz;
        const nz = ux;
        const curbOffset = width * 0.5 + 0.2;
        for (let dist = 4; dist <= length - 2.5; dist += 8) {
          const side = Math.floor(dist / 8) % 2 === 0 ? 1 : -1;
          lampTransforms.push({
            x: seg.fromX + ux * dist + nx * curbOffset * side,
            y: yDeck + deckHeight * 0.5,
            z: seg.fromY + uz * dist + nz * curbOffset * side,
            rotY: Math.atan2(-nx * side, -nz * side),
          });
        }
      }
    }

    // 8. Build intersections (`degree >= 3`): junction pad, stop lines, zebra crosswalks & L-shaped traffic lights
    this.buildIntersections(nodeMap);

    // 9. Build instanced streetlights across all urban streets (2 draw calls total)
    if (lampTransforms.length > 0) {
      this.buildInstancedStreetlights(lampTransforms);
    }

    this.applyLayerVisibility();
  }

  private buildIntersections(nodeMap: ReadonlyMap<string, NetworkSegmentDto[]>): void {
    let idx = 0;
    for (const [key, incident] of nodeMap) {
      if (incident.length < 3) continue;
      const parts = key.split(",");
      const nx = Number(parts[0]);
      const nz = Number(parts[1]);
      idx += 1;

      let maxWidth = 1.4;
      let hasUrban = false;
      let worstHealth = 100;
      for (const s of incident) {
        const w = WIDTH_BY_KIND[s.kind] ?? 1.4;
        if (w > maxWidth) maxWidth = w;
        if (URBAN_STREET_KINDS.has(s.kind)) hasUrban = true;
        if (s.healthPercent < worstHealth) worstHealth = s.healthPercent;
      }

      const yDeck = 0.14;
      const padRadius = maxWidth * 0.66;
      if (hasUrban) {
        const swDisc = new THREE.Mesh(
          new THREE.CylinderGeometry(padRadius + 0.3, padRadius + 0.3, 0.12, 16),
          new THREE.MeshLambertMaterial({ color: 0xcbd5e1 })
        );
        swDisc.position.set(nx, yDeck - 0.018, nz);
        swDisc.receiveShadow = true;
        this.segmentsGroup.add(swDisc);
      }

      const juncColor = worstHealth < 40 ? 0x7f1d1d : worstHealth < 75 ? 0x57534e : 0x334155;
      const juncDisc = new THREE.Mesh(
        new THREE.CylinderGeometry(padRadius, padRadius, 0.132, 16),
        new THREE.MeshLambertMaterial({ color: juncColor })
      );
      juncDisc.position.set(nx, yDeck + 0.008, nz);
      juncDisc.receiveShadow = true;
      this.segmentsGroup.add(juncDisc);

      // Stop lines + 5-stripe zebra crosswalks on each approach
      for (const seg of incident) {
        const atStart = Math.hypot(seg.fromX - nx, seg.fromY - nz) <= Math.hypot(seg.toX - nx, seg.toY - nz);
        const ox = atStart ? seg.toX - seg.fromX : seg.fromX - seg.toX;
        const oz = atStart ? seg.toY - seg.fromY : seg.fromY - seg.toY;
        const segLen = Math.hypot(ox, oz);
        const approachOffset = padRadius + 0.42;
        if (segLen < approachOffset + 1.1) continue;

        const ux = ox / segLen;
        const uz = oz / segLen;
        const segW = WIDTH_BY_KIND[seg.kind] ?? 1.4;
        const rotY = -Math.atan2(uz, ux);
        const markY = yDeck + 0.082;

        // Zebra crosswalk (5 crisp white stripes)
        const stripeCount = segW >= 2.0 ? 5 : 4;
        const usableW = segW * 0.84;
        const stripeW = (usableW / stripeCount) * 0.56;
        const px = -uz;
        const pz = ux;
        for (let s = 0; s < stripeCount; s++) {
          const lateral = -usableW * 0.5 + (s + 0.5) * (usableW / stripeCount);
          const zebra = new THREE.Mesh(
            new THREE.BoxGeometry(0.48, 0.016, stripeW),
            new THREE.MeshBasicMaterial({ color: 0xf8fafc })
          );
          zebra.position.set(
            nx + ux * approachOffset + px * lateral,
            markY,
            nz + uz * approachOffset + pz * lateral
          );
          zebra.rotation.y = rotY;
          zebra.userData.hideUnderground = true;
          this.segmentsGroup.add(zebra);
        }

        // White stop line right behind the zebra crosswalk
        const stopDist = approachOffset + 0.46;
        const stopLine = new THREE.Mesh(
          new THREE.BoxGeometry(0.14, 0.016, segW * 0.88),
          new THREE.MeshBasicMaterial({ color: 0xffffff })
        );
        stopLine.position.set(nx + ux * stopDist, markY, nz + uz * stopDist);
        stopLine.rotation.y = rotY;
        stopLine.userData.hideUnderground = true;
        this.segmentsGroup.add(stopLine);
      }

      // Two opposing L-shaped traffic light poles (NS phase & EW phase)
      for (let corner = 0; corner < 2; corner++) {
        const sign = corner === 0 ? 1 : -1;
        const poleX = nx + sign * (padRadius + 0.16);
        const poleZ = nz - sign * (padRadius + 0.16);

        const poleMat = new THREE.MeshLambertMaterial({ color: 0x1e293b });
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 1.55, 6), poleMat);
        mast.position.set(poleX, yDeck + 0.78, poleZ);
        mast.userData.hideUnderground = true;
        this.segmentsGroup.add(mast);

        const armLen = 0.72;
        const arm = new THREE.Mesh(new THREE.BoxGeometry(armLen, 0.055, 0.055), poleMat.clone());
        arm.position.set(poleX - sign * armLen * 0.45, yDeck + 1.52, poleZ);
        arm.userData.hideUnderground = true;
        this.segmentsGroup.add(arm);

        const housing = new THREE.Mesh(
          new THREE.BoxGeometry(0.36, 0.14, 0.14),
          new THREE.MeshLambertMaterial({ color: 0x0f172a })
        );
        const hx = poleX - sign * armLen * 0.72;
        housing.position.set(hx, yDeck + 1.46, poleZ);
        housing.userData.hideUnderground = true;
        this.segmentsGroup.add(housing);

        const redMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
        const yellowMat = new THREE.MeshBasicMaterial({ color: 0x422006 });
        const greenMat = new THREE.MeshBasicMaterial({ color: 0x14532d });

        const lampOffsets: readonly [number, THREE.MeshBasicMaterial][] = [
          [-0.1, redMat],
          [0, yellowMat],
          [0.1, greenMat],
        ];
        for (const [lx, lMat] of lampOffsets) {
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.048, 6, 6), lMat);
          dot.position.set(hx + lx, yDeck + 1.46, poleZ + sign * 0.07);
          dot.userData.hideUnderground = true;
          this.segmentsGroup.add(dot);
        }

        this.signalSets.push({
          red: redMat,
          yellow: yellowMat,
          green: greenMat,
          phaseOffset: (idx * 1.7) + corner * 6,
        });
      }
    }
  }

  private buildInstancedStreetlights(
    lamps: readonly { x: number; y: number; z: number; rotY: number }[]
  ): void {
    const count = lamps.length;
    const poleGeo = new THREE.CylinderGeometry(0.035, 0.05, 1.35, 5);
    poleGeo.translate(0, 0.675, 0);
    const poleMesh = new THREE.InstancedMesh(
      poleGeo,
      new THREE.MeshLambertMaterial({ color: 0x475569 }),
      count
    );

    const headGeo = new THREE.BoxGeometry(0.16, 0.07, 0.28);
    headGeo.translate(0, 1.36, 0.1);
    const headMesh = new THREE.InstancedMesh(
      headGeo,
      new THREE.MeshBasicMaterial({ color: 0xfef08a }),
      count
    );

    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const l = lamps[i]!;
      dummy.position.set(l.x, l.y, l.z);
      dummy.rotation.set(0, l.rotY, 0);
      dummy.updateMatrix();
      poleMesh.setMatrixAt(i, dummy.matrix);
      headMesh.setMatrixAt(i, dummy.matrix);
    }
    poleMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
    this.segmentsGroup.add(poleMesh);
    this.segmentsGroup.add(headMesh);
  }

  /** Lattice HV power pylons every 10 tiles + 3 sagging catenary conductors (`hv_power`). */
  private buildHvPowerSegment(seg: NetworkSegmentDto, dx: number, dz: number, length: number): void {
    const steps = Math.max(1, Math.round(length / 10));
    const angleY = -Math.atan2(dz, dx);
    const nx = -(dz / length);
    const nz = dx / length;

    const pylonPositions: { x: number; z: number }[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = seg.fromX + dx * t;
      const pz = seg.fromY + dz * t;
      pylonPositions.push({ x: px, z: pz });

      // Lattice steel tower body (4-sided tapered frame) + cross-arms
      const towerH = 3.2;
      const lattice = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.48, towerH, 4, 2, true),
        new THREE.MeshLambertMaterial({ color: 0x94a3b8, wireframe: true })
      );
      lattice.position.set(px, towerH * 0.5 + 0.05, pz);
      lattice.rotation.y = angleY + Math.PI * 0.25;
      lattice.userData.segmentId = seg.id;
      this.segmentsGroup.add(lattice);

      const spine = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.14, towerH, 4),
        new THREE.MeshLambertMaterial({ color: 0x64748b })
      );
      spine.position.set(px, towerH * 0.5 + 0.05, pz);
      spine.userData.segmentId = seg.id;
      this.segmentsGroup.add(spine);

      const crossArm = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.12, 1.45),
        new THREE.MeshLambertMaterial({ color: 0x94a3b8 })
      );
      crossArm.position.set(px, 2.85, pz);
      crossArm.rotation.y = angleY;
      this.segmentsGroup.add(crossArm);
    }

    // Sagging catenary power conductors between consecutive pylons
    for (let i = 0; i < pylonPositions.length - 1; i++) {
      const a = pylonPositions[i]!;
      const b = pylonPositions[i + 1]!;
      for (const lat of [-0.62, 0, 0.62]) {
        const pts: THREE.Vector3[] = [];
        const samples = 8;
        for (let s = 0; s <= samples; s++) {
          const u = s / samples;
          const sag = 0.42 * 4 * u * (1 - u);
          pts.push(
            new THREE.Vector3(
              a.x + (b.x - a.x) * u + nx * lat,
              2.82 - sag,
              a.z + (b.z - a.z) * u + nz * lat
            )
          );
        }
        const wireGeo = new THREE.BufferGeometry().setFromPoints(pts);
        const wire = new THREE.Line(
          wireGeo,
          new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85 })
        );
        this.segmentsGroup.add(wire);
      }
    }
  }

  /** Orange/steel trunk pipeline on concrete saddle piers + red shutoff valves (`pipeline`). */
  private buildPipelineSegment(seg: NetworkSegmentDto, dx: number, dz: number, length: number): void {
    const midX = seg.fromX + dx * 0.5;
    const midZ = seg.fromY + dz * 0.5;
    const angleY = -Math.atan2(dz, dx);
    const yPipe = seg.hasBridge || seg.isFlyover ? 1.55 : 0.42;

    const pipeGeo = new THREE.CylinderGeometry(0.24, 0.24, length + 0.3, 10);
    pipeGeo.rotateZ(Math.PI * 0.5);
    const pipe = new THREE.Mesh(
      pipeGeo,
      new THREE.MeshLambertMaterial({ color: 0xea580c })
    );
    pipe.position.set(midX, yPipe, midZ);
    pipe.rotation.y = angleY;
    pipe.castShadow = true;
    pipe.userData.segmentId = seg.id;
    this.segmentsGroup.add(pipe);

    // Concrete saddle supports every 4 tiles + red shutoff handwheel valves every 12 tiles
    const pierCount = Math.max(1, Math.floor(length / 4));
    for (let i = 0; i <= pierCount; i++) {
      const t = pierCount === 0 ? 0.5 : i / pierCount;
      const px = seg.fromX + dx * t;
      const pz = seg.fromY + dz * t;
      const support = new THREE.Mesh(
        new THREE.BoxGeometry(0.26, yPipe, 0.62),
        new THREE.MeshLambertMaterial({ color: 0xcbd5e1 })
      );
      support.position.set(px, yPipe * 0.46, pz);
      support.rotation.y = angleY;
      this.segmentsGroup.add(support);

      if (i > 0 && i % 3 === 0) {
        const valveStem = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, 0.06, 0.28, 6),
          new THREE.MeshLambertMaterial({ color: 0x94a3b8 })
        );
        valveStem.position.set(px, yPipe + 0.28, pz);
        this.segmentsGroup.add(valveStem);

        const wheel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.22, 0.22, 0.05, 10),
          new THREE.MeshLambertMaterial({ color: 0xdc2626 })
        );
        wheel.position.set(px, yPipe + 0.42, pz);
        this.segmentsGroup.add(wheel);
      }
    }
  }

  /** Cycles R/Y/G traffic signals across all `degree >= 3` intersections (12-second full cycle). */
  public updateSignals(elapsedSeconds: number): void {
    for (let i = 0; i < this.signalSets.length; i++) {
      const s = this.signalSets[i]!;
      const phase = (elapsedSeconds + s.phaseOffset) % 12;
      if (phase < 4.8) {
        // Green
        s.green.color.setHex(0x22c55e);
        s.yellow.color.setHex(0x422006);
        s.red.color.setHex(0x450a0a);
      } else if (phase < 6.0) {
        // Yellow
        s.green.color.setHex(0x14532d);
        s.yellow.color.setHex(0xfacc15);
        s.red.color.setHex(0x450a0a);
      } else {
        // Red
        s.green.color.setHex(0x14532d);
        s.yellow.color.setHex(0x422006);
        s.red.color.setHex(0xef4444);
      }
    }
  }
}
