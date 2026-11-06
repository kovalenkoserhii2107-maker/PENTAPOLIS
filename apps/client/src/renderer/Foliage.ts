/**
 * Tree & bush models for the instanced foliage layer.
 *
 * Each species is one merged low-poly geometry with baked vertex colours (darker underside,
 * sunlit top, per-blob variation) so a crown reads as a clump of leaves rather than a single
 * polyhedron; the per-instance colour then tints it (greens, autumn reds, dark conifer greens).
 * Trunks are a separate instanced mesh so they are never tinted green.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type TreeSpecies = "broadleaf" | "conifer" | "poplar" | "bush";

function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return (s & 0xffff) / 0xffff;
  };
}

/** Bakes a vertical light gradient (and a flat multiplier) into the vertex colours. */
function paint(geo: THREE.BufferGeometry, bottomY: number, topY: number, low: number, high: number, mul = 1): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute("uv");
  const pos = g.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - bottomY) / Math.max(0.001, topY - bottomY)));
    const v = (low + (high - low) * t) * mul;
    colors[i * 3] = v;
    colors[i * 3 + 1] = v;
    colors[i * 3 + 2] = v;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

function blob(radius: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(radius, 0);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

/** Round deciduous crown: a clump of 4 leaf blobs around a central mass. */
function broadleafCrown(): THREE.BufferGeometry {
  const r = rand(7);
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(blob(0.62, 0, 1.25, 0, 1, 0.9, 1), 0.7, 1.85, 0.62, 1.12));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + r() * 0.6;
    const rad = 0.32 + r() * 0.12;
    const y = 1.05 + r() * 0.45;
    parts.push(paint(blob(0.36 + r() * 0.12, Math.cos(a) * rad, y, Math.sin(a) * rad), y - 0.45, y + 0.45, 0.6, 1.1, 0.9 + r() * 0.2));
  }
  parts.push(paint(blob(0.34, 0.05, 1.72, -0.04), 1.4, 2.05, 0.95, 1.18));
  return mergeGeometries(parts)!;
}

/** Spruce / pine: three stacked cone tiers, each darker at its skirt. */
function coniferCrown(): THREE.BufferGeometry {
  const tiers: [number, number, number][] = [
    [0.62, 0.95, 0.55],
    [0.48, 0.85, 1.05],
    [0.32, 0.75, 1.5],
  ];
  const parts = tiers.map(([radius, height, base]) => {
    const g = new THREE.ConeGeometry(radius, height, 7, 1, true);
    g.translate(0, base + height / 2, 0);
    return paint(g, base, base + height, 0.55, 1.08);
  });
  return mergeGeometries(parts)!;
}

/** Lombardy poplar / cypress: a tall narrow column (roadsides, coast). */
function poplarCrown(): THREE.BufferGeometry {
  const parts = [
    paint(blob(0.36, 0, 1.15, 0, 1, 1.9, 1), 0.5, 1.85, 0.6, 1.08),
    paint(blob(0.28, 0.04, 1.85, 0.02, 1, 1.4, 1), 1.5, 2.25, 0.85, 1.15),
  ];
  return mergeGeometries(parts)!;
}

/** Low shrub: three small blobs, no trunk. */
function bushCrown(): THREE.BufferGeometry {
  const parts = [
    paint(blob(0.3, 0, 0.22, 0, 1, 0.8, 1), 0, 0.5, 0.62, 1.08),
    paint(blob(0.22, 0.24, 0.18, 0.1), 0, 0.42, 0.6, 1.05),
    paint(blob(0.2, -0.18, 0.17, 0.16), 0, 0.38, 0.65, 1.0),
  ];
  return mergeGeometries(parts)!;
}

export function createSpeciesGeometry(species: TreeSpecies): THREE.BufferGeometry {
  switch (species) {
    case "broadleaf":
      return broadleafCrown();
    case "conifer":
      return coniferCrown();
    case "poplar":
      return poplarCrown();
    case "bush":
      return bushCrown();
  }
}

export function createTrunkGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.07, 0.11, 0.95, 5, 1, true);
  g.translate(0, 0.47, 0);
  return g;
}

/** Instance tints per species (sRGB hex); `autumn` are the warm accents of broadleaf groves. */
export const SPECIES_TINTS: Readonly<Record<TreeSpecies, readonly number[]>> = {
  broadleaf: [0x5f9a35, 0x4f8c2e, 0x6ba83c, 0x47812b, 0x7aa83f],
  conifer: [0x2f6340, 0x2a5a36, 0x3a6b3c, 0x2c5440],
  poplar: [0x4f8a32, 0x5c9438, 0x3f7a35],
  bush: [0x5a8f33, 0x6b9a3a, 0x4d7f2c, 0x7f9a40],
};
export const AUTUMN_TINTS: readonly number[] = [0xc2452d, 0xd9782a, 0xd8a02a, 0xb33a2a];
