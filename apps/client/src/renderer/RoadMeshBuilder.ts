/**
 * Procedural 90° & 45° Transport / Utility Network Mesh Builder.
 *
 * Renders:
 * - Orthogonal (`0°/90°`) and diagonal (`45°`) road ribbons (`street_2lane` .. `heavy_bypass`),
 *   heavy rail (`rail`), pipelines (`pipeline`), HV lines (`hv_power`), and underground tunnels (`metro_tunnel`);
 * - River bridges (`hasBridge === true`) & flyovers (`isFlyover === true`) elevated at `Z = +1` (`y = 1.6`) with piers;
 * - Road wear tint by GDD §5.2 stage (worn 74–40%, emergency <40%);
 * - Underground Overlay (Sprint 5): metro tunnels appear only in the underground view, where the
 *   surface network fades to an orientation ghost. Vehicles are drawn by `TrafficRenderer`.
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

export class RoadMeshBuilder {
  public readonly group = new THREE.Group();
  private readonly segmentsGroup = new THREE.Group();
  private undergroundView = false;

  constructor() {
    this.group.add(this.segmentsGroup);
  }

  public setUndergroundView(on: boolean): void {
    this.undergroundView = on;
    this.applyLayerVisibility();
  }

  private applyLayerVisibility(): void {
    for (const child of this.segmentsGroup.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const mat = child.material as THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;
      if (child.userData.underground) {
        child.visible = this.undergroundView;
      } else {
        mat.transparent = this.undergroundView;
        mat.opacity = this.undergroundView ? 0.18 : 1;
        mat.depthWrite = !this.undergroundView;
      }
    }
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
          ? 0.2
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
      const mat =
        seg.kind === "metro_tunnel"
          ? new THREE.MeshBasicMaterial({ color: 0x818cf8 })
          : new THREE.MeshLambertMaterial({ color: baseColor });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.segmentId = seg.id;
      mesh.userData.underground = seg.kind === "metro_tunnel";
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
    }

    pierGeo.dispose();
    pierMat.dispose();
    this.applyLayerVisibility();
  }
}
