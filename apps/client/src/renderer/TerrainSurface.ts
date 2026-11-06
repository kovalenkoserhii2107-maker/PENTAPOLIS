/**
 * Landscape & sea surface (land, beaches, rivers, animated water, relief shading).
 *
 * The gameplay grid is 1000×1000 tiles of Sea / Land / River / Mainland. Drawing it as a pixel
 * texture gives stair-stepped coasts and flat colours. Instead we turn the grid into signed
 * distance fields (tiles to the nearest shore / river bank / open sea), upload them as one
 * linearly filtered texture and let a fragment shader paint:
 * - smooth shorelines with sand beaches, wet sand and rocky shores under the southern mountains;
 * - shallow turquoise water fading into the deep sea, animated waves, surf foam and sun glints;
 * - meadows, steppe and forest floor with soft hillshaded relief (higher in the southern ranges);
 * - dashed sector borders and the gold Central Core ring, drawn analytically so they stay smooth.
 *
 * The material stays a `MeshLambertMaterial` (patched via `onBeforeCompile`) so building shadows
 * and scene lighting keep working.
 */
import * as THREE from "three";
import {
  CORE_CENTER_X,
  CORE_CENTER_Y,
  CORE_RADIUS_TILES,
  GRID_HEIGHT,
  GRID_WIDTH,
  SECTOR_BOUNDARY_DEGREES,
  SurfaceType,
} from "@pentapolis/shared-sim";

/** Texel scale of the signed distance channels: 6 steps per tile, ±21 tiles of range. */
const SDF_SCALE = 6;
/** Texel scale of the sea-depth channel: 4 steps per tile, up to 63 tiles. */
const DEPTH_SCALE = 4;
/** Forest floor mask resolution: one texel per 4×4 tiles. */
export const FOREST_MASK_CELL = 4;

const INF = 1e20;

/** Felzenszwalb–Huttenlocher 1D squared distance transform (in place over `f`, length `n`). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
  }
}

/** Euclidean distance (tiles) from every cell to the nearest cell where `isFeature` is true. */
function distanceTo(isFeature: (i: number) => boolean, w: number, h: number): Float32Array {
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = isFeature(i) ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]!;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x]!;
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[row + x] = d[x]!;
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(grid[i]!);
  return out;
}

/** Separable box blur (radius `r`, in place) to round off the tile staircase in a distance field. */
function boxBlur(field: Float32Array, w: number, h: number, r: number): void {
  const tmp = new Float32Array(field.length);
  const span = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += field[row + Math.min(w - 1, Math.max(0, x + k))]!;
      tmp[row + x] = sum / span;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]!;
      field[y * w + x] = sum / span;
    }
  }
}

export interface TerrainFields {
  /** Signed tiles to the sea shore: > 0 on land (incl. rivers & mainland), < 0 at sea. */
  readonly coast: Float32Array;
  /** Signed tiles to a river bank: > 0 outside rivers, < 0 inside. */
  readonly river: Float32Array;
}

export function computeTerrainFields(surface: Uint8Array): TerrainFields {
  const w = GRID_WIDTH;
  const h = GRID_HEIGHT;
  const isSea = (i: number) => surface[i] === SurfaceType.Sea;
  const isRiver = (i: number) => surface[i] === SurfaceType.River;
  const toSea = distanceTo(isSea, w, h);
  const toLand = distanceTo((i) => !isSea(i), w, h);
  const toRiver = distanceTo(isRiver, w, h);
  const toBank = distanceTo((i) => !isRiver(i), w, h);
  const coast = new Float32Array(w * h);
  const river = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    coast[i] = isSea(i) ? -(toLand[i]! - 0.5) : toSea[i]! - 0.5;
    river[i] = isRiver(i) ? -(toBank[i]! - 0.5) : toRiver[i]! - 0.5;
  }
  // Two light passes ≈ a small Gaussian: smooth curves instead of a one-tile staircase
  for (let pass = 0; pass < 2; pass++) {
    boxBlur(coast, w, h, 1);
    boxBlur(river, w, h, 1);
  }
  return { coast, river };
}

function fieldTexture(fields: TerrainFields): THREE.DataTexture {
  const n = GRID_WIDTH * GRID_HEIGHT;
  const rgba = new Uint8Array(n * 4);
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let i = 0; i < n; i++) {
    const c = fields.coast[i]!;
    rgba[i * 4] = clamp(128 + c * SDF_SCALE);
    rgba[i * 4 + 1] = clamp(128 + fields.river[i]! * SDF_SCALE);
    rgba[i * 4 + 2] = clamp(Math.max(0, -c) * DEPTH_SCALE);
    rgba[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(rgba, GRID_WIDTH, GRID_HEIGHT, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

const GLSL_NOISE = /* glsl */ `
  float tHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float tNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = tHash(i);
    float b = tHash(i + vec2(1.0, 0.0));
    float c = tHash(i + vec2(0.0, 1.0));
    float d = tHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float tFbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      s += a * tNoise(p);
      p = mat2(1.6, 1.2, -1.2, 1.6) * p;
      a *= 0.5;
    }
    return s;
  }
`;

/** Height of the decorative relief (no gameplay effect): low hills everywhere, a range in the south. */
const GLSL_RELIEF = /* glsl */ `
  float tMountains(vec2 p, float coast) {
    // Southern range along the coast (Crimean-style Main Ridge), fading inland
    float south = smoothstep(560.0, 720.0, p.y) * (1.0 - smoothstep(880.0, 960.0, p.y));
    float alongCoast = smoothstep(2.0, 10.0, coast) * (1.0 - smoothstep(55.0, 120.0, coast));
    return clamp(south * alongCoast * 1.25, 0.0, 1.0);
  }
  float tHeight(vec2 p, float mountains, float fine) {
    float hills = tFbm(p * 0.018) * 0.55 + tFbm(p * 0.06) * 0.18 * fine;
    float ridges = 1.0 - abs(tFbm(p * 0.03 + 7.0) * 2.0 - 1.0);
    return hills + mountains * (ridges * ridges * 2.6 + tFbm(p * 0.11) * 0.4 * fine);
  }
`;

/** Shared helpers: field decoding, mainland outline, shoreline wobble. */
const GLSL_FIELDS = /* glsl */ `
  uniform sampler2D uFields;
  uniform vec3 uSunDir;
  ${GLSL_NOISE}
  ${GLSL_RELIEF}

  vec3 tSrgb(vec3 c) { return pow(c, vec3(2.2)); }

  float tMainlandEdge(float x) {
    return 26.0 + 6.0 * sin(x * 0.017 + 0.4) + 3.0 * sin(x * 0.043 + 1.3);
  }

  // coast (tiles, > 0 land), river (tiles, < 0 in a river), depth (tiles of sea to the shore)
  vec3 tFields(vec2 p, out bool outside) {
    vec2 uv = p / vec2(${GRID_WIDTH.toFixed(1)}, ${GRID_HEIGHT.toFixed(1)});
    outside = uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0;
    vec4 fld = texture2D(uFields, uv);
    float coast = (fld.r * 255.0 - 128.0) / ${SDF_SCALE.toFixed(1)};
    float riverD = (fld.g * 255.0 - 128.0) / ${SDF_SCALE.toFixed(1)};
    float depth = fld.b * 255.0 / ${DEPTH_SCALE.toFixed(1)};
    if (outside) {
      // Beyond the grid: open sea, except the mainland that continues to the north
      float mainland = tMainlandEdge(p.x) - p.y;
      coast = mainland > 0.0 ? mainland : max(mainland, -60.0);
      depth = max(0.0, -mainland) * 0.8 + 4.0;
      riverD = 30.0;
    }
    // Natural irregularity of the shoreline and river banks (visual only, under a tile)
    coast += (tFbm(p * 0.21) - 0.5) * 1.4;
    riverD += (tNoise(p * 0.18) - 0.5) * 0.35;
    depth = max(depth, -coast);
    return vec3(coast, riverD, depth);
  }
`;

/**
 * One-off bake of the static ground (meadows, steppe, relief, rock, beaches, river banks) into a
 * 2048² texture: rgb = ground colour (sRGB-encoded), a = hillshade / 1.5.
 */
const BAKE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const BAKE_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  ${GLSL_FIELDS}
  void main() {
    vec2 p = vUv * vec2(${GRID_WIDTH.toFixed(1)}, ${GRID_HEIGHT.toFixed(1)});
    bool outside;
    vec3 f = tFields(p, outside);
    float coast = f.x;
    float riverD = f.y;
    float mountains = tMountains(p, coast);

    vec3 meadow = tSrgb(vec3(0.42, 0.60, 0.27));
    vec3 lush = tSrgb(vec3(0.33, 0.53, 0.22));
    vec3 steppe = tSrgb(vec3(0.66, 0.64, 0.38));
    vec3 rock = tSrgb(vec3(0.56, 0.53, 0.47));
    vec3 sand = tSrgb(vec3(0.88, 0.81, 0.62));
    vec3 wetSand = tSrgb(vec3(0.70, 0.63, 0.48));

    float big = tFbm(p * 0.0045 + 3.0);
    float northEast = clamp((420.0 - p.y) / 260.0 + (p.x - 640.0) / 420.0, 0.0, 1.0);
    float dryness = smoothstep(0.42, 0.78, big + northEast * 0.35) * (1.0 - mountains);
    vec3 land = mix(meadow, steppe, dryness * 0.75);
    land = mix(land, lush, smoothstep(0.45, 0.75, tFbm(p * 0.05)) * 0.55);
    // Lusher grass along rivers
    land = mix(land, lush, (1.0 - smoothstep(0.0, 9.0, riverD)) * 0.6);

    // Relief: hillshade from the decorative height field, bare rock only on the steepest slopes
    float e = 1.2;
    float h0 = tHeight(p, mountains, 1.0);
    float hx = tHeight(p + vec2(e, 0.0), mountains, 1.0);
    float hz = tHeight(p + vec2(0.0, e), mountains, 1.0);
    float relief = 6.0 + mountains * 14.0;
    vec3 rn = normalize(vec3((h0 - hx) * relief, e, (h0 - hz) * relief));
    float shade = clamp(dot(rn, uSunDir) / max(uSunDir.y, 0.2), 0.6, 1.3);
    land = mix(land, rock, smoothstep(0.22, 0.42, 1.0 - rn.y) * mountains * 0.8);

    // Beaches (rocky shore under the mountains)
    float beachW = 2.4 + (tNoise(p * 0.08) - 0.5) * 1.6;
    vec3 col = mix(mix(sand, rock * 0.9, mountains), land, smoothstep(beachW * 0.6, beachW + 0.8, coast));
    col = mix(mix(wetSand, rock * 0.75, mountains), col, smoothstep(0.0, 0.7, coast));
    // River banks
    col = mix(tSrgb(vec3(0.46, 0.43, 0.30)), col, smoothstep(0.0, 0.9, riverD));
    // Beaches stay flat-lit; shading fades in with the grass
    shade = mix(1.0, shade, smoothstep(1.0, 4.0, coast));
    gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), shade / 1.5);
  }
`;

const VERTEX_DECL = /* glsl */ `
  varying vec2 vTile;
`;
const VERTEX_BODY = /* glsl */ `
  vTile = (modelMatrix * vec4(position, 1.0)).xz;
`;

const FRAGMENT_DECL = /* glsl */ `
  uniform sampler2D uGround;
  uniform sampler2D uForest;
  uniform float uTime;
  uniform float uBorders;
  uniform vec3 uViewDir;
  uniform float uBoundaries[5];
  varying vec2 vTile;
  ${GLSL_FIELDS}

  float tAngleDist(float a, float b) {
    float d = abs(a - b);
    return min(d, 360.0 - d);
  }
`;

const FRAGMENT_COLOR = /* glsl */ `
  vec2 p = vTile;
  vec2 uv = p / vec2(${GRID_WIDTH.toFixed(1)}, ${GRID_HEIGHT.toFixed(1)});
  bool outside;
  vec3 f = tFields(p, outside);
  float coast = f.x;
  float riverD = f.y;
  float depth = f.z;
  float mountains = tMountains(p, coast);

  // Screen footprint of a pixel in tiles: fine detail fades out instead of sparkling when zoomed out
  float tPix = max(length(fwidth(p)), 1e-4);
  float fine1 = 1.0 - smoothstep(0.25, 0.7, 0.55 * tPix);
  float fine2 = 1.0 - smoothstep(0.25, 0.7, 1.3 * tPix);
  float fine3 = 1.0 - smoothstep(0.25, 0.7, 5.3 * tPix);

  float glint = 0.0;

  // ------------------------------------------------------------------ Ground (baked) + live layers
  vec3 col;
  float shade = 1.0;
  if (outside) {
    col = mix(tSrgb(vec3(0.42, 0.60, 0.27)), tSrgb(vec3(0.66, 0.64, 0.38)), smoothstep(0.35, 0.7, tFbm(p * 0.0045 + 3.0)) * 0.75);
  } else {
    vec4 ground = texture2D(uGround, uv);
    col = pow(ground.rgb, vec3(2.2));
    shade = ground.a * 1.5;
  }
  // Forest floor under the woods (mask written by the foliage pass)
  float forest = texture2D(uForest, uv).r * smoothstep(2.5, 4.5, coast) * smoothstep(0.5, 2.0, riverD);
  col = mix(col, tSrgb(vec3(0.20, 0.36, 0.17)), forest * 0.7);
  // Fine grain so the ground reads crisp up close
  col *= 1.0 + (tNoise(p * 1.7) - 0.5) * 0.1 * fine2 + (tNoise(p * 5.3) - 0.5) * 0.05 * fine3;
  col *= mix(1.0, shade, 0.7);

  // ------------------------------------------------------------------ Water surface
  vec2 flow = vec2(uTime * 0.9, uTime * 0.55);
  if (coast < 0.0 || riverD < 0.0) {
    float w1 = 0.5 + (tNoise(p * 0.55 + flow) - 0.5) * fine1;
    float w2 = 0.5 + (tNoise(p * 1.3 - flow * 1.6 + 17.0) - 0.5) * fine2;
    // Broad swell for the sheen, small chop only adds a little sparkle up close
    float s1 = tNoise(p * 0.16 + flow * 0.35);
    float s2 = tNoise(p * 0.07 - flow * 0.2 + 5.0);
    vec3 waveN = normalize(vec3((s1 - 0.5) * 0.55 + (w1 - 0.5) * 0.25 * fine1, 1.0, (s2 - 0.5) * 0.55 + (w2 - 0.5) * 0.2 * fine2));
    float rv = max(dot(reflect(-uSunDir, waveN), uViewDir), 0.0);
    // Sun sparkles only up close; from afar they would read as whitecaps everywhere
    float spec = pow(rv, 260.0) * 0.5 * (1.0 - smoothstep(0.1, 0.3, tPix));

    if (coast < 0.0) {
      float w3 = tNoise(p * 0.12 + vec2(uTime * 0.12, 0.0));
      vec3 shallow = tSrgb(vec3(0.24, 0.70, 0.70));
      vec3 sea = mix(shallow, tSrgb(vec3(0.10, 0.45, 0.62)), smoothstep(0.5, 9.0, depth));
      sea = mix(sea, tSrgb(vec3(0.05, 0.20, 0.40)), smoothstep(8.0, 34.0, depth));
      sea = mix(sea, tSrgb(vec3(0.03, 0.12, 0.28)), smoothstep(40.0, 75.0, depth + (w3 - 0.5) * 6.0));
      // Sandy bottom showing through right at the shore
      sea = mix(mix(tSrgb(vec3(0.88, 0.81, 0.62)), shallow, 0.45), sea, smoothstep(0.0, 1.8, depth));
      sea *= 0.95 + (w1 * 0.6 + w2 * 0.4) * 0.1 + (s1 - 0.5) * 0.06;
      // Surf: a moving line of foam rolling onto the beach plus a white rim at the waterline
      float surfPhase = fract(-depth * 0.45 + uTime * 0.35 + tNoise(p * 0.21) * 0.8);
      float surf = smoothstep(0.82, 0.95, surfPhase) * (1.0 - smoothstep(0.5, 4.5, depth));
      float rim = 1.0 - smoothstep(0.0, 0.55 + w2 * 0.4, depth);
      float foam = clamp(max(surf * (0.55 + w2 * 0.5), rim), 0.0, 1.0) * (1.0 - mountains * 0.3);
      sea = mix(sea, tSrgb(vec3(0.94, 0.97, 0.98)), foam * 0.85);
      col = mix(sea, col, smoothstep(-0.25, 0.0, coast));
      glint = spec * (0.6 + smoothstep(2.0, 20.0, depth) * 0.8);
      tWaterSheen = pow(rv, 6.0) * 0.012;
    } else {
      vec3 riverCol = mix(tSrgb(vec3(0.20, 0.52, 0.56)), tSrgb(vec3(0.10, 0.36, 0.50)), smoothstep(0.0, 2.2, -riverD));
      riverCol *= 0.92 + w2 * 0.14;
      float ripple = smoothstep(0.8, 0.98, tNoise(p * 0.5 + vec2(uTime * 1.1, uTime * 0.7))) * fine1;
      riverCol = mix(riverCol, tSrgb(vec3(0.62, 0.80, 0.84)), ripple * 0.25);
      col = mix(riverCol, col, smoothstep(-0.3, 0.0, riverD));
      glint = spec * 0.5;
    }
  }

  // ------------------------------------------------------------------ Borders
  if (uBorders > 0.5 && coast > 0.0 && riverD > -0.2) {
    vec2 d = p - vec2(${CORE_CENTER_X.toFixed(1)}, ${CORE_CENTER_Y.toFixed(1)});
    float r = length(d);
    float deg = degrees(atan(d.y, d.x));
    if (deg < 0.0) deg += 360.0;
    float aa = fwidth(r) * 1.2 + 0.05;
    float ring = 1.0 - smoothstep(0.35, 0.35 + aa, abs(r - ${CORE_RADIUS_TILES.toFixed(1)}));
    col = mix(col, tSrgb(vec3(0.98, 0.76, 0.22)), ring * 0.9);
    if (r > ${CORE_RADIUS_TILES.toFixed(1)} + 0.5) {
      float best = 1e5;
      for (int i = 0; i < 5; i++) {
        best = min(best, radians(tAngleDist(deg, uBoundaries[i])) * r);
      }
      float line = 1.0 - smoothstep(0.22, 0.22 + aa, best);
      float dash = step(0.45, fract(r / 7.0));
      col = mix(col, tSrgb(vec3(0.97, 0.97, 0.94)), line * dash * 0.8);
    }
  }

  diffuseColor.rgb = col;
`;

export interface TerrainSurface {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshLambertMaterial;
  readonly fields: TerrainFields;
  /** Writes the forest-floor mask (one byte per `FOREST_MASK_CELL`² tiles, 0..255). */
  setForestMask(mask: Uint8Array): void;
  update(elapsedSeconds: number): void;
  dispose(): void;
}

export const FOREST_MASK_W = Math.ceil(GRID_WIDTH / FOREST_MASK_CELL);
export const FOREST_MASK_H = Math.ceil(GRID_HEIGHT / FOREST_MASK_CELL);

/** Resolution of the baked ground texture (≈ 0.5 tile per texel). */
const GROUND_BAKE_SIZE = 2048;

function bakeGround(renderer: THREE.WebGLRenderer, fieldTex: THREE.Texture, sunDir: THREE.Vector3): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(GROUND_BAKE_SIZE, GROUND_BAKE_SIZE, {
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
  });
  const material = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERTEX,
    fragmentShader: BAKE_FRAGMENT,
    uniforms: { uFields: { value: fieldTex }, uSunDir: { value: sunDir } },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(previous);
  quad.geometry.dispose();
  material.dispose();
  return target;
}

export function createTerrainSurface(
  renderer: THREE.WebGLRenderer,
  surface: Uint8Array,
  sunDir: THREE.Vector3,
  viewDir: THREE.Vector3
): TerrainSurface {
  const fields = computeTerrainFields(surface);
  const fieldTex = fieldTexture(fields);
  const sun = sunDir.clone().normalize();
  const ground = bakeGround(renderer, fieldTex, sun);

  const forestData = new Uint8Array(FOREST_MASK_W * FOREST_MASK_H);
  const forestTex = new THREE.DataTexture(forestData, FOREST_MASK_W, FOREST_MASK_H, THREE.RedFormat);
  forestTex.magFilter = THREE.LinearFilter;
  forestTex.minFilter = THREE.LinearFilter;
  forestTex.flipY = false;
  forestTex.needsUpdate = true;

  const uniforms = {
    uFields: { value: fieldTex },
    uGround: { value: ground.texture },
    uForest: { value: forestTex },
    uTime: { value: 0 },
    uBorders: { value: 1 },
    uSunDir: { value: sun },
    uViewDir: { value: viewDir.clone().normalize() },
    uBoundaries: { value: [...SECTOR_BOUNDARY_DEGREES] },
  };

  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_DECL}`)
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_DECL}`)
      .replace("#include <map_fragment>", `{\n${FRAGMENT_COLOR}\n  diffuseColor.rgb *= diffuse;\n  tWaterGlint = glint;\n}`)
      .replace("void main() {", "void main() {\n  float tWaterGlint = 0.0;\n  float tWaterSheen = 0.0;")
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n  totalEmissiveRadiance += vec3(1.0, 0.97, 0.88) * tWaterGlint + vec3(0.45, 0.7, 1.0) * tWaterSheen;"
      );
  };
  material.customProgramCacheKey = () => "pentapolis-terrain-v2";

  // A wide plane so the sea continues to the horizon when zoomed out
  const span = 7000;
  const geo = new THREE.PlaneGeometry(span, span, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(GRID_WIDTH * 0.5, 0, GRID_HEIGHT * 0.5);
  mesh.receiveShadow = true;

  return {
    mesh,
    material,
    fields,
    setForestMask(mask: Uint8Array) {
      forestData.set(mask.subarray(0, forestData.length));
      forestTex.needsUpdate = true;
    },
    update(elapsed: number) {
      uniforms.uTime.value = elapsed;
    },
    dispose() {
      geo.dispose();
      material.dispose();
      fieldTex.dispose();
      forestTex.dispose();
      ground.dispose();
    },
  };
}
