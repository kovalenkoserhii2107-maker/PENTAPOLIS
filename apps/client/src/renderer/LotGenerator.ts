/**
 * Crisp TheoTown-Inspired Procedural Building & RCI Lot Generator (`LotGenerator.ts`).
 *
 * Uses `pickBuildingVisual()` from `@pentapolis/shared-sim` so every placed building renders
 * deterministically from the 140,580-look catalog without external `.glb` dependencies:
 * - Crisp ink edge outlines (`addCrispOutline`, `EdgesGeometry` at 25°);
 * - Procedural roof silhouettes (`buildRoofMesh`: Gable, Hip/Pyramidal, Mansard/Gambrel,
 *   Shed, Sawtooth, Dome/Vaulted, Green roof, Flat/Stepped parapet with HVAC/antennas);
 * - Detailed `128×128` pixel-crisp `CanvasTexture` facades (`NearestFilter`) honoring
 *   `facadeName`, `wearState` (`new`, `lived_in`, `worn`), and ground-floor storefronts/docks;
 * - 15 Corporate Brand canopies, roadside price totems, and 3D friezes (`BIZ-09..11`, `FIN-01`);
 * - Residential yard fences/gardens/garages (`propSetIndex`) and differentiated industrial
 *   silhouettes (mine headframes & stepped pits, spherical/cylindrical tank farms & pipe racks,
 *   hyperboloid cooling towers & red-white stacks, animated 3-blade wind turbines & solar arrays).
 */
import * as THREE from "three";
import {
  hashString32,
  pickBuildingVisual,
  type BuildingCatalogEntry,
  type BuildingDto,
  type CorporateBrandSpec,
  type DistrictClassId,
  type DistrictDto,
  type MasterCatalogs,
  type ResolvedBuildingVisual,
  type SectorId,
  type WearState,
  type ZoneDto,
  type ZoneSiteStatusDto,
} from "@pentapolis/shared-sim";

const OUTLINE_MATERIALS = new Map<number, THREE.LineBasicMaterial>();

function getSharedOutlineMaterial(opacity: number): THREE.LineBasicMaterial {
  const key = Math.round(opacity * 100);
  let mat = OUTLINE_MATERIALS.get(key);
  if (!mat) {
    mat = new THREE.LineBasicMaterial({
      color: 0x0f172a,
      transparent: true,
      opacity: key / 100,
    });
    OUTLINE_MATERIALS.set(key, mat);
  }
  return mat;
}

/**
 * Attaches crisp dark-ink `LineSegments` (`EdgesGeometry` threshold 25°) to a mesh
 * for signature TheoTown isometric legibility.
 */
export function addCrispOutline(mesh: THREE.Mesh, opacity = 0.42): THREE.LineSegments {
  const edgesGeo = new THREE.EdgesGeometry(mesh.geometry, 25);
  const lines = new THREE.LineSegments(edgesGeo, getSharedOutlineMaterial(opacity));
  lines.userData.sharedMaterial = true;
  mesh.add(lines);
  return lines;
}

interface RoofExtraOptions {
  readonly floors?: number;
  readonly isLowRiseHouse?: boolean;
  readonly seed?: number;
}

function makeGablePrismGeometry(spanWidth: number, ridgeLength: number, height: number): THREE.BufferGeometry {
  const halfW = spanWidth * 0.5;
  const shape = new THREE.Shape();
  shape.moveTo(-halfW, 0);
  shape.lineTo(halfW, 0);
  shape.lineTo(0, height);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth: ridgeLength, bevelEnabled: false });
  geo.translate(0, 0, -ridgeLength * 0.5);
  return geo;
}

function makeWedgeGeometry(width: number, depth: number, lowH: number, highH: number): THREE.BufferGeometry {
  const halfD = depth * 0.5;
  const shape = new THREE.Shape();
  shape.moveTo(-halfD, 0);
  shape.lineTo(halfD, 0);
  shape.lineTo(halfD, lowH);
  shape.lineTo(-halfD, highH);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  geo.translate(0, 0, -width * 0.5);
  geo.rotateY(Math.PI * 0.5);
  return geo;
}

/**
 * Procedural roof geometry builder placed on top of the main building volume (`y = 0` is roof base).
 */
export function buildRoofMesh(
  roofName: string,
  bw: number,
  bd: number,
  roofHex: string,
  accentHex: string,
  extra: RoofExtraOptions = {}
): THREE.Object3D {
  const root = new THREE.Group();
  const norm = roofName.trim().toLowerCase();
  const seed = extra.seed ?? 17;
  const roofMat = new THREE.MeshLambertMaterial({ color: roofHex, flatShading: true });
  const accentMat = new THREE.MeshLambertMaterial({ color: accentHex });

  // 1. Gable (двускатная) — triangular prism along the longer side + +0.18 eave overhang + chimney
  if (norm.includes("gable") || norm.includes("barn")) {
    const overhang = 0.18;
    const rw = bw + overhang * 2;
    const rd = bd + overhang * 2;
    const alongX = bw >= bd;
    const span = alongX ? rd : rw;
    const len = alongX ? rw : rd;
    const rh = Math.max(0.55, Math.min(2.1, Math.min(bw, bd) * 0.42));

    const geo = makeGablePrismGeometry(span, len, rh);
    if (alongX) geo.rotateY(Math.PI * 0.5);
    const prism = new THREE.Mesh(geo, roofMat);
    prism.castShadow = true;
    prism.receiveShadow = true;
    addCrispOutline(prism, 0.45);
    root.add(prism);

    if (extra.isLowRiseHouse || (extra.floors ?? 3) <= 2) {
      const chimH = rh * 0.95;
      const chim = new THREE.Mesh(
        new THREE.BoxGeometry(0.26, chimH, 0.26),
        new THREE.MeshLambertMaterial({ color: 0x7c2d12 })
      );
      chim.position.set(bw * 0.2, rh * 0.55, -bd * 0.16);
      chim.castShadow = true;
      addCrispOutline(chim, 0.38);
      root.add(chim);
    } else {
      accentMat.dispose();
    }
    return root;
  }

  // 2. Hip / Pyramidal (вальмовая / шатровая) — 4-sided truncated pyramid rotated 45°
  if (norm.includes("hip") || norm.includes("pyramid")) {
    const rw = bw + 0.28;
    const rd = bd + 0.28;
    const rh = Math.max(0.55, Math.min(2.0, Math.min(bw, bd) * 0.38));
    const topRatio = norm.includes("pyramid") ? 0.06 : 0.38;
    const geo = new THREE.CylinderGeometry(topRatio * Math.SQRT1_2, Math.SQRT1_2, rh, 4);
    geo.rotateY(Math.PI * 0.25);
    geo.scale(rw, 1, rd);
    geo.translate(0, rh * 0.5, 0);

    const hip = new THREE.Mesh(geo, roofMat);
    hip.castShadow = true;
    hip.receiveShadow = true;
    addCrispOutline(hip, 0.44);
    root.add(hip);
    accentMat.dispose();
    return root;
  }

  // 3. Mansard / Gambrel (мансардная) — 2-tier sloped roof + perimeter dormers
  if (norm.includes("mansard") || norm.includes("gambrel")) {
    const rw = bw + 0.22;
    const rd = bd + 0.22;
    const h1 = Math.max(0.5, Math.min(1.3, Math.min(bw, bd) * 0.28));
    const h2 = h1 * 0.52;

    const lowerGeo = new THREE.CylinderGeometry(0.76 * Math.SQRT1_2, Math.SQRT1_2, h1, 4);
    lowerGeo.rotateY(Math.PI * 0.25);
    lowerGeo.scale(rw, 1, rd);
    lowerGeo.translate(0, h1 * 0.5, 0);
    const lower = new THREE.Mesh(lowerGeo, roofMat);
    lower.castShadow = true;
    addCrispOutline(lower, 0.44);
    root.add(lower);

    const upperGeo = new THREE.CylinderGeometry(0.28 * Math.SQRT1_2, 0.76 * Math.SQRT1_2, h2, 4);
    upperGeo.rotateY(Math.PI * 0.25);
    upperGeo.scale(rw, 1, rd);
    upperGeo.translate(0, h1 + h2 * 0.5, 0);
    const upper = new THREE.Mesh(upperGeo, accentMat);
    upper.castShadow = true;
    addCrispOutline(upper, 0.38);
    root.add(upper);

    // Dormer windows along front & back slopes
    const dormerMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
    const count = Math.max(1, Math.min(3, Math.floor(bw / 1.4)));
    for (let i = 0; i < count; i++) {
      const xOff = count === 1 ? 0 : -bw * 0.28 + (i / (count - 1)) * bw * 0.56;
      for (const zSign of [-1, 1]) {
        const dormer = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.38, 0.34), dormerMat.clone());
        dormer.position.set(xOff, h1 * 0.52, zSign * (bd * 0.42));
        addCrispOutline(dormer, 0.35);
        root.add(dormer);
      }
    }
    dormerMat.dispose();
    return root;
  }

  // 4. Shed (односкатная) — angled wedge + solar collector / lip canopy
  if (norm.includes("shed")) {
    const rw = bw + 0.2;
    const rd = bd + 0.2;
    const highH = Math.max(0.45, Math.min(1.5, Math.min(bw, bd) * 0.32));
    const wedgeGeo = makeWedgeGeometry(rw, rd, 0.12, highH);
    const wedge = new THREE.Mesh(wedgeGeo, roofMat);
    wedge.castShadow = true;
    addCrispOutline(wedge, 0.42);
    root.add(wedge);

    // Angled rooftop solar collector panel
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(bw * 0.62, 0.06, bd * 0.48),
      new THREE.MeshLambertMaterial({ color: 0x1d4ed8 })
    );
    const tilt = Math.atan2(highH - 0.12, rd);
    panel.position.set(0, (highH + 0.12) * 0.5 + 0.06, 0);
    panel.rotation.x = tilt;
    addCrispOutline(panel, 0.35);
    root.add(panel);
    accentMat.dispose();
    return root;
  }

  // 5. Sawtooth (шедовая заводская крыша для PRO-*, CMP-*, ASM-*) — 3–4 glazed sawtooth ridges
  if (norm.includes("sawtooth")) {
    const bays = Math.max(3, Math.min(4, Math.round(bd / 2.2)));
    const bayD = bd / bays;
    const ridgeH = Math.max(0.65, Math.min(1.6, bayD * 0.46));
    const glassMat = new THREE.MeshLambertMaterial({ color: 0x7dd3fc });

    for (let i = 0; i < bays; i++) {
      const zCenter = -bd * 0.5 + (i + 0.5) * bayD;
      const toothGeo = makeWedgeGeometry(bw, bayD * 0.96, 0.1, ridgeH);
      const tooth = new THREE.Mesh(toothGeo, roofMat.clone());
      tooth.position.set(0, 0, zCenter);
      tooth.castShadow = true;
      addCrispOutline(tooth, 0.42);
      root.add(tooth);

      const skylight = new THREE.Mesh(
        new THREE.BoxGeometry(bw * 0.92, ridgeH * 0.78, 0.08),
        glassMat.clone()
      );
      skylight.position.set(0, ridgeH * 0.48, zCenter - bayD * 0.46);
      root.add(skylight);
    }
    roofMat.dispose();
    glassMat.dispose();
    accentMat.dispose();
    return root;
  }

  // 6. Dome / Vaulted (купольная / сводчатая для CIV-*, MEG-*, BANK)
  if (norm.includes("dome") || norm.includes("vault")) {
    const parapet = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.24, bd), accentMat);
    parapet.position.y = 0.12;
    addCrispOutline(parapet, 0.4);
    root.add(parapet);

    if (norm.includes("vault")) {
      const radius = Math.min(bw, bd) * 0.36;
      const len = Math.max(bw, bd) * 0.84;
      const vaultGeo = new THREE.CylinderGeometry(radius, radius, len, 12, 1, false, 0, Math.PI);
      vaultGeo.rotateZ(Math.PI * 0.5);
      if (bd > bw) vaultGeo.rotateY(Math.PI * 0.5);
      const vault = new THREE.Mesh(vaultGeo, roofMat);
      vault.position.y = 0.22;
      vault.castShadow = true;
      addCrispOutline(vault, 0.38);
      root.add(vault);
    } else {
      const r = Math.min(bw, bd) * 0.34;
      const drum = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 1.04, r * 1.08, 0.42, 12),
        new THREE.MeshLambertMaterial({ color: 0xe2e8f0 })
      );
      drum.position.y = 0.42;
      addCrispOutline(drum, 0.38);
      root.add(drum);

      const domeGeo = new THREE.SphereGeometry(r, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5);
      const dome = new THREE.Mesh(domeGeo, roofMat);
      dome.position.y = 0.62;
      dome.castShadow = true;
      addCrispOutline(dome, 0.36);
      root.add(dome);

      const spire = new THREE.Mesh(
        new THREE.ConeGeometry(0.1, 0.65, 6),
        new THREE.MeshLambertMaterial({ color: 0xfbbf24 })
      );
      spire.position.y = 0.62 + r + 0.3;
      root.add(spire);
    }
    return root;
  }

  // 7. Green roof (эко-крыша для богатых кварталов "R" и OFF-02)
  if (norm.includes("green")) {
    const rimMat = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
    const wallT = 0.16;
    const pH = 0.28;
    for (const [sx, sz, px, pz] of [
      [bw, wallT, 0, -bd * 0.5 + wallT * 0.5],
      [bw, wallT, 0, bd * 0.5 - wallT * 0.5],
      [wallT, bd - wallT * 2, -bw * 0.5 + wallT * 0.5, 0],
      [wallT, bd - wallT * 2, bw * 0.5 - wallT * 0.5, 0],
    ] as const) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(sx, pH, sz), rimMat.clone());
      p.position.set(px, pH * 0.5, pz);
      addCrispOutline(p, 0.36);
      root.add(p);
    }
    rimMat.dispose();

    const turf = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(0.4, bw - wallT * 2.2), 0.12, Math.max(0.4, bd - wallT * 2.2)),
      new THREE.MeshLambertMaterial({ color: 0x22c55e })
    );
    turf.position.y = 0.08;
    root.add(turf);

    const treeCount = Math.max(2, Math.min(4, Math.floor((bw + bd) * 0.5)));
    for (let i = 0; i < treeCount; i++) {
      const angle = (i / treeCount) * Math.PI * 2 + (seed % 7) * 0.4;
      const rx = Math.cos(angle) * Math.max(0.2, bw * 0.24);
      const rz = Math.sin(angle) * Math.max(0.2, bd * 0.24);
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.07, 0.26, 5),
        new THREE.MeshLambertMaterial({ color: 0x78350f })
      );
      trunk.position.set(rx, 0.24, rz);
      root.add(trunk);

      const crown = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.24, 0),
        new THREE.MeshLambertMaterial({ color: i % 2 === 0 ? 0x15803d : 0x16a34a, flatShading: true })
      );
      crown.position.set(rx, 0.48, rz);
      root.add(crown);
    }
    roofMat.dispose();
    accentMat.dispose();
    return root;
  }

  // 8. Flat / Stepped parapet — perimeter concrete parapet + 1–3 HVAC units, elevator penthouse & antenna
  const parapetColor = 0x94a3b8;
  const wallT = Math.min(0.18, Math.min(bw, bd) * 0.09);
  const pH = 0.24;
  const tarDeck = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(0.4, bw - wallT * 1.6), 0.08, Math.max(0.4, bd - wallT * 1.6)),
    roofMat
  );
  tarDeck.position.y = 0.04;
  root.add(tarDeck);

  const rimMat = new THREE.MeshLambertMaterial({ color: parapetColor });
  for (const [sx, sz, px, pz] of [
    [bw, wallT, 0, -bd * 0.5 + wallT * 0.5],
    [bw, wallT, 0, bd * 0.5 - wallT * 0.5],
    [wallT, Math.max(0.1, bd - wallT * 2), -bw * 0.5 + wallT * 0.5, 0],
    [wallT, Math.max(0.1, bd - wallT * 2), bw * 0.5 - wallT * 0.5, 0],
  ] as const) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(sx, pH, sz), rimMat.clone());
    p.position.set(px, pH * 0.5, pz);
    addCrispOutline(p, 0.38);
    root.add(p);
  }
  rimMat.dispose();

  if (norm.includes("stepped") || (extra.floors ?? 1) >= 10) {
    const stepCrown = new THREE.Mesh(
      new THREE.BoxGeometry(bw * 0.68, 0.38, bd * 0.68),
      accentMat
    );
    stepCrown.position.y = 0.26;
    addCrispOutline(stepCrown, 0.4);
    root.add(stepCrown);
  } else {
    accentMat.dispose();
  }

  // Procedural HVAC units (1..3) + elevator bulkhead / antenna
  const hvacCount = 1 + (seed % 3);
  const hvacMat = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
  const fanMat = new THREE.MeshLambertMaterial({ color: 0x1e293b });
  for (let i = 0; i < hvacCount; i++) {
    const hx = ((i - (hvacCount - 1) * 0.5) * bw) * 0.26;
    const hz = ((i % 2 === 0 ? -1 : 1) * bd) * 0.18;
    const unitW = Math.min(0.55, bw * 0.22);
    const unitD = Math.min(0.45, bd * 0.2);
    const unit = new THREE.Mesh(new THREE.BoxGeometry(unitW, 0.28, unitD), hvacMat.clone());
    unit.position.set(hx, 0.22, hz);
    addCrispOutline(unit, 0.35);
    root.add(unit);

    const fan = new THREE.Mesh(new THREE.CylinderGeometry(unitW * 0.28, unitW * 0.28, 0.04, 8), fanMat.clone());
    fan.position.set(hx, 0.37, hz);
    root.add(fan);
  }
  hvacMat.dispose();
  fanMat.dispose();

  if ((extra.floors ?? 2) >= 5 && bw >= 1.8 && bd >= 1.8) {
    const bulkhead = new THREE.Mesh(
      new THREE.BoxGeometry(Math.min(0.9, bw * 0.3), 0.62, Math.min(0.8, bd * 0.28)),
      new THREE.MeshLambertMaterial({ color: 0x64748b })
    );
    bulkhead.position.set(-bw * 0.18, 0.38, bd * 0.16);
    addCrispOutline(bulkhead, 0.4);
    root.add(bulkhead);
  }

  if (seed % 2 === 0 && (extra.floors ?? 2) >= 4) {
    const mastH = Math.min(2.2, 0.7 + (extra.floors ?? 4) * 0.08);
    const antenna = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.045, mastH, 5),
      new THREE.MeshLambertMaterial({ color: 0xe2e8f0 })
    );
    antenna.position.set(bw * 0.22, mastH * 0.5 + 0.1, -bd * 0.22);
    root.add(antenna);
  }

  return root;
}

type GroundFloorStyle = "retail" | "warehouse" | "residential_entry" | "industrial" | "house";

function classifyGroundFloor(catalogId: string, visualFamily: string, floors: number): GroundFloorStyle {
  if (
    catalogId.startsWith("COM-") ||
    catalogId.startsWith("BIZ-") ||
    catalogId.startsWith("LEI-") ||
    catalogId.startsWith("TOU-") ||
    catalogId.startsWith("FIN-") ||
    visualFamily === "SUPERMARKET" ||
    visualFamily === "BANK" ||
    visualFamily === "STOREFRONT" ||
    visualFamily === "FUEL"
  ) {
    return "retail";
  }
  if (
    catalogId.startsWith("LOG-") ||
    catalogId === "CIV-04" ||
    catalogId === "INF-13" ||
    catalogId === "TRN-02" ||
    catalogId === "TRN-04" ||
    catalogId === "TRN-07" ||
    catalogId === "TRN-10"
  ) {
    return "warehouse";
  }
  if (catalogId === "RES-02" || catalogId === "RES-03" || catalogId === "CIV-02" || (catalogId.startsWith("OFF-") && floors >= 4)) {
    return "residential_entry";
  }
  if (
    catalogId.startsWith("EXT-") ||
    catalogId.startsWith("PRO-") ||
    catalogId.startsWith("CMP-") ||
    catalogId.startsWith("ASM-") ||
    catalogId.startsWith("ENG-")
  ) {
    return "industrial";
  }
  return "house";
}

/**
 * Generates a crisp `128×128` (`NearestFilter`) procedural building facade texture honoring
 * `facadeName`, `wearState`, `floors`, and ground-floor usage.
 */
export function createCrispFacadeTexture(
  wallHex: string,
  accentHex: string,
  floors: number,
  facadeName = "Render",
  wearState: WearState = "new",
  groundStyle: GroundFloorStyle = "house"
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;

  const fNorm = facadeName.toLowerCase();
  const isGlass = fNorm.includes("glass");
  const isPanel = fNorm.includes("panel");
  const isBrickOrStone = fNorm.includes("brick") || fNorm.includes("stone");
  const isMetal = fNorm.includes("metal");
  const isTimber = fNorm.includes("timber") || fNorm.includes("wood");

  // Base facade fill / sky gradient for glass curtain towers
  if (isGlass) {
    const grad = ctx.createLinearGradient(0, 0, 128, 128);
    grad.addColorStop(0, "#0ea5e9");
    grad.addColorStop(0.5, "#1e3a8a");
    grad.addColorStop(1, "#38bdf8");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);

    // Diagonal sky reflection band
    ctx.fillStyle = "rgba(224, 242, 254, 0.22)";
    ctx.beginPath();
    ctx.moveTo(18, 0);
    ctx.lineTo(54, 0);
    ctx.lineTo(12, 128);
    ctx.lineTo(-10, 128);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = wallHex;
    ctx.fillRect(0, 0, 128, 128);
  }

  // Material surface detailing
  if (isPanel) {
    // Inter-panel mortar grid seams
    ctx.fillStyle = "rgba(15, 23, 42, 0.24)";
    for (let x = 16; x < 128; x += 16) ctx.fillRect(x, 6, 1, 96);
    for (let y = 12; y < 102; y += 12) ctx.fillRect(0, y, 128, 1);
    if (wearState !== "new") {
      for (let py = 12; py < 96; py += 12) {
        for (let px = 0; px < 128; px += 16) {
          if (((px * 3 + py * 7) & 3) === 0) {
            ctx.fillStyle = wearState === "worn" ? "rgba(15,23,42,0.12)" : "rgba(255,255,255,0.07)";
            ctx.fillRect(px + 1, py + 1, 15, 11);
          }
        }
      }
    }
  } else if (isBrickOrStone) {
    // Subtle masonry courses + corner quoins (рустовка углов)
    ctx.fillStyle = "rgba(15, 23, 42, 0.09)";
    for (let y = 8; y < 104; y += 4) ctx.fillRect(0, y, 128, 1);
    ctx.fillStyle = "rgba(248, 250, 252, 0.35)";
    for (let y = 6; y < 102; y += 8) {
      const longQuoin = ((y >> 3) & 1) === 0;
      const qw = longQuoin ? 9 : 6;
      ctx.fillRect(0, y, qw, 6);
      ctx.fillRect(128 - qw, y, qw, 6);
    }
  } else if (isMetal) {
    // Vertical corrugated cladding ribs
    ctx.fillStyle = "rgba(15, 23, 42, 0.16)";
    for (let x = 0; x < 128; x += 4) ctx.fillRect(x, 6, 1, 114);
  } else if (isTimber) {
    // Horizontal clapboard wood planks
    ctx.fillStyle = "rgba(15, 23, 42, 0.14)";
    for (let y = 6; y < 118; y += 5) ctx.fillRect(0, y, 128, 1);
  }

  // Cornice & plinth bands
  ctx.fillStyle = accentHex;
  ctx.fillRect(0, 0, 128, 6);
  ctx.fillStyle = "#334155";
  ctx.fillRect(0, 122, 128, 6);

  const groundTopY = groundStyle === "house" ? 118 : 96;
  const upperRows = Math.max(1, Math.min(12, groundStyle === "house" ? Math.max(1, floors) : Math.max(1, floors - 1)));
  const availH = groundTopY - 10;
  const rowH = Math.max(6, Math.floor(availH / upperRows));
  const cols = isGlass ? 8 : 6;
  const colStep = Math.floor(112 / cols);

  // Upper floor windows, mullions, sills & balconies
  for (let r = 0; r < upperRows; r++) {
    const wy = 9 + r * rowH;
    const winH = Math.max(3, rowH - 4);
    for (let c = 0; c < cols; c++) {
      const wx = 9 + c * colStep;
      const winW = Math.max(5, colStep - (isGlass ? 3 : 7));
      const h = (r * 17 + c * 31) % 7;
      const lit = h !== 0 && h !== 3;

      if (isGlass) {
        ctx.fillStyle = lit ? "rgba(224, 242, 254, 0.72)" : "rgba(15, 23, 42, 0.45)";
        ctx.fillRect(wx, wy, winW, winH);
      } else {
        if (wearState === "new") {
          ctx.fillStyle = lit ? (h === 1 ? "#fef3c7" : "#dbeafe") : "#1e293b";
        } else if (wearState === "lived_in") {
          ctx.fillStyle = lit ? (h === 2 ? "#fde68a" : "#93c5fd") : "#334155";
        } else {
          ctx.fillStyle = lit ? "#cbd5e1" : "#0f172a";
        }
        ctx.fillRect(wx, wy, winW, winH);

        // Window sill / lintel on brick & stone facades
        if (isBrickOrStone) {
          ctx.fillStyle = "#e2e8f0";
          ctx.fillRect(wx - 1, wy - 1, winW + 2, 1);
          ctx.fillRect(wx - 1, wy + winH, winW + 2, 2);
        }

        // Checkerboard loggias / balconies on panel concrete apartments
        if (isPanel && ((r + c) & 1) === 0 && winH >= 4) {
          ctx.fillStyle = accentHex;
          ctx.fillRect(wx - 1, wy + Math.floor(winH * 0.55), winW + 2, Math.ceil(winH * 0.45) + 1);
          ctx.fillStyle = "rgba(15, 23, 42, 0.35)";
          ctx.fillRect(wx, wy + winH, winW, 1);
        }
      }
    }
  }

  // Vertical aluminum mullions on glass curtain towers
  if (isGlass) {
    ctx.fillStyle = "#cbd5e1";
    for (let x = 8; x <= 120; x += colStep) ctx.fillRect(x, 6, 2, groundTopY - 6);
    for (let r = 0; r <= upperRows; r++) ctx.fillRect(6, 8 + r * rowH, 116, 1);
  }

  // Ground floor architectural program
  if (groundStyle === "retail") {
    // Colored shop awning (маркиза) + bright warm display windows + glass entrance doors
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(4, 96, 120, 26);
    ctx.fillStyle = accentHex;
    ctx.fillRect(2, 93, 124, 6);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    for (let sx = 6; sx < 122; sx += 8) ctx.fillRect(sx, 93, 4, 6);

    // Wide illuminated shopfront vitrines
    ctx.fillStyle = "#fef08a";
    ctx.fillRect(10, 101, 38, 17);
    ctx.fillRect(80, 101, 38, 17);
    ctx.fillStyle = "#38bdf8";
    ctx.fillRect(54, 102, 20, 20);
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(63, 102, 2, 20);
  } else if (groundStyle === "warehouse") {
    // Sectional roll-up loading dock doors + hazard bollards
    ctx.fillStyle = "#475569";
    ctx.fillRect(0, 96, 128, 26);
    for (let dx = 10; dx <= 86; dx += 38) {
      ctx.fillStyle = "#cbd5e1";
      ctx.fillRect(dx, 100, 28, 22);
      ctx.fillStyle = "#64748b";
      for (let sy = 103; sy < 121; sy += 3) ctx.fillRect(dx + 1, sy, 26, 1);
      ctx.fillStyle = "#facc15";
      ctx.fillRect(dx - 2, 114, 2, 8);
      ctx.fillRect(dx + 28, 114, 2, 8);
    }
  } else if (groundStyle === "residential_entry") {
    // Entrance doors with projecting concrete canopies
    for (const ex of [26, 86]) {
      ctx.fillStyle = accentHex;
      ctx.fillRect(ex - 4, 98, 22, 4);
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(ex, 102, 14, 20);
      ctx.fillStyle = "#bae6fd";
      ctx.fillRect(ex + 3, 105, 8, 6);
    }
  } else if (groundStyle === "industrial") {
    // Hazard safety band + heavy factory gate
    ctx.fillStyle = "#facc15";
    ctx.fillRect(0, 118, 128, 4);
    ctx.fillStyle = "#0f172a";
    for (let hx = 0; hx < 128; hx += 8) ctx.fillRect(hx, 118, 4, 4);
    ctx.fillStyle = "#334155";
    ctx.fillRect(46, 98, 36, 24);
  }

  // Worn state: damp streaks under cornice & plinth cracks / pixel graffiti
  if (wearState === "worn") {
    ctx.fillStyle = "rgba(15, 23, 42, 0.28)";
    for (const sx of [14, 39, 71, 103, 115]) {
      ctx.fillRect(sx, 6, 3, 14 + (sx % 11));
    }
    // Plinth cracks
    ctx.fillStyle = "rgba(15, 23, 42, 0.5)";
    ctx.fillRect(18, 115, 1, 7);
    ctx.fillRect(19, 113, 2, 3);
    ctx.fillRect(96, 114, 2, 8);
    // Tiny colorful street graffiti near plinth
    ctx.fillStyle = "#ec4899";
    ctx.fillRect(22, 114, 9, 5);
    ctx.fillStyle = "#22d3ee";
    ctx.fillRect(25, 115, 5, 3);
    ctx.fillStyle = "#facc15";
    ctx.fillRect(99, 115, 8, 4);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** District tiers 1..5 (sheet 25 Table 5): industrial outskirts (rust) -> elite enclave (gold). */
const TIER_COLORS = [0x9a3412, 0xd97706, 0x65a30d, 0x0891b2, 0xfacc15];

export type HeatmapOverlayKind = "none" | "land_value" | "pollution" | "coverage";

export class LotGenerator {
  public readonly group = new THREE.Group();
  private readonly cranes: { boom: THREE.Object3D; stalled: boolean }[] = [];
  private readonly windRotors: THREE.Object3D[] = [];
  private readonly textureCache = new Map<string, THREE.CanvasTexture>();
  private internalElapsed = 0;

  private getFacadeTexture(
    wallHex: string,
    accentHex: string,
    floors: number,
    facadeName: string,
    wearState: WearState,
    groundStyle: GroundFloorStyle
  ): THREE.CanvasTexture {
    const key = `${wallHex}|${accentHex}|${Math.min(12, floors)}|${facadeName}|${wearState}|${groundStyle}`;
    const hit = this.textureCache.get(key);
    if (hit) return hit;
    const tex = createCrispFacadeTexture(wallHex, accentHex, floors, facadeName, wearState, groundStyle);
    this.textureCache.set(key, tex);
    return tex;
  }

  private disposeGroupChildren(): void {
    const cachedTextures = new Set<THREE.Texture>(this.textureCache.values());
    while (this.group.children.length > 0) {
      const child = this.group.children.pop()!;
      child.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          if (obj.userData.sharedMaterial) return;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            const lm = m as THREE.MeshLambertMaterial;
            if (lm.map && !cachedTextures.has(lm.map)) {
              lm.map.dispose();
            }
            m.dispose();
          }
        }
      });
    }
    this.cranes.length = 0;
    this.windRotors.length = 0;
  }

  private resolveRoofChoice(
    vis: ResolvedBuildingVisual | null,
    entry: BuildingCatalogEntry | undefined,
    districtClass: DistrictClassId,
    floors: number
  ): string {
    const catalogId = entry?.id ?? vis?.catalogId ?? "";
    const prefix = entry?.prefix ?? catalogId.split("-")[0] ?? "";

    if (prefix === "PRO" || prefix === "CMP" || prefix === "ASM") {
      return "Sawtooth";
    }
    if (
      catalogId === "CIV-01" ||
      catalogId === "EDU-04" ||
      catalogId.startsWith("MEG-") ||
      catalogId === "LEI-06" ||
      catalogId === "LEI-09" ||
      catalogId === "FIN-02"
    ) {
      return catalogId === "LEI-09" || catalogId === "MEG-01" ? "Vaulted" : "Dome";
    }
    if (catalogId === "OFF-02" || (districtClass === "R" && vis?.roofName === "Flat" && floors >= 3)) {
      return "Green roof";
    }
    if (vis?.roofName && vis.roofName !== "-") {
      return vis.roofName;
    }
    if (catalogId === "RES-01" || catalogId === "COM-01") return "Gable";
    if (floors >= 8) return "Stepped parapet";
    return "Flat";
  }

  public rebuild(
    buildings: readonly BuildingDto[],
    zones: readonly ZoneDto[],
    catalogs: MasterCatalogs,
    selectedBuildingId: string | null,
    zoneSites: ReadonlyMap<string, ZoneSiteStatusDto> = new Map(),
    districts: ReadonlyMap<string, DistrictDto> = new Map(),
    overlayOrBool: boolean | HeatmapOverlayKind = false
  ): void {
    this.disposeGroupChildren();
    const overlay: HeatmapOverlayKind =
      typeof overlayOrBool === "boolean" ? (overlayOrBool ? "land_value" : "none") : overlayOrBool;

    // 1. Render RCI Zoned Lots & private developer subdivisions
    for (const z of zones) {
      const district = districts.get(z.id);
      const zoneClass: DistrictClassId =
        (z as { districtClass?: DistrictClassId }).districtClass ?? district?.visualClass ?? "M";

      let zoneColor = z.zoneKind.startsWith("RES-")
        ? 0x16a34a
        : z.zoneKind.startsWith("COM-")
          ? 0x2563eb
          : 0x9333ea;
      if (overlay === "land_value" && district) {
        zoneColor = TIER_COLORS[district.tier - 1]!;
      } else if (overlay === "pollution" && district) {
        zoneColor = district.ecology >= 0.75 ? 0x22c55e : district.ecology >= 0.45 ? 0xfacc15 : 0xef4444;
      } else if (overlay === "coverage" && district) {
        const cov =
          (district.coverage.police + district.coverage.fire + district.coverage.health + district.coverage.school) *
          0.25;
        zoneColor = cov >= 0.7 ? 0x06b6d4 : cov >= 0.35 ? 0xf59e0b : 0xef4444;
      }

      const padGeo = new THREE.BoxGeometry(z.width, 0.08, z.depth);
      const padMat = new THREE.MeshLambertMaterial({
        color: zoneColor,
        transparent: true,
        opacity: overlay !== "none" ? 0.82 : 0.32,
      });
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.position.set(z.x + z.width * 0.5, 0.05, z.y + z.depth * 0.5);
      this.group.add(pad);

      // Subdivide occupied cells into crisp procedural houses / mid-rises / towers
      const step = z.zoneKind === "RES-01" || z.zoneKind === "COM-01" ? 3 : 4;
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
            ? pickBuildingVisual(lotId, catEntry, catalogs.visuals, z.sectorId, zoneClass)
            : null;
          const floors =
            z.zoneKind === "RES-03" || z.zoneKind === "OFF-02" || z.zoneKind === "COM-03"
              ? 12 + ((gx + gz) % 6)
              : z.zoneKind === "RES-02" || z.zoneKind === "COM-02" || z.zoneKind === "OFF-01"
                ? 5 + ((gx + gz) % 3)
                : Math.max(1, Math.min(3, vis?.floors ?? 2));
          const h = floors * 0.65;
          const lotCx = z.x + gx * step + step * 0.5;
          const lotCz = z.y + gz * step + step * 0.5;
          const bw = z.zoneKind === "RES-01" ? step - 1.15 : step - 0.72;
          const bd = z.zoneKind === "RES-01" ? step - 1.15 : step - 0.72;

          const groundStyle = classifyGroundFloor(z.zoneKind, vis?.visualFamily ?? "SINGLE-MODEL", floors);
          const tex = this.getFacadeTexture(
            vis?.wallHex ?? "#cbd5e1",
            vis?.accentHex ?? "#475569",
            floors,
            vis?.facadeName ?? (z.zoneKind === "OFF-02" ? "Glass curtain" : "Render"),
            vis?.wearState ?? "new",
            groundStyle
          );
          const bodyGeo = new THREE.BoxGeometry(bw, h, bd);
          const capMat = new THREE.MeshLambertMaterial({ color: vis?.roofHex ?? "#475569" });
          const wallMat = new THREE.MeshLambertMaterial({ map: tex });
          const box = new THREE.Mesh(bodyGeo, [
            wallMat,
            wallMat,
            capMat,
            capMat,
            wallMat,
            wallMat,
          ]);
          box.position.set(
            lotCx,
            h * 0.5 + 0.08,
            z.zoneKind === "RES-01" ? lotCz - 0.18 : lotCz
          );
          box.castShadow = true;
          box.receiveShadow = true;
          addCrispOutline(box, 0.42);
          this.group.add(box);

          const roofChoice = this.resolveRoofChoice(vis, catEntry, zoneClass, floors);
          const roofObj = buildRoofMesh(
            roofChoice,
            bw,
            bd,
            vis?.roofHex ?? "#475569",
            vis?.accentHex ?? "#94a3b8",
            {
              floors,
              isLowRiseHouse: z.zoneKind === "RES-01",
              seed: hashString32(lotId, 9),
            }
          );
          roofObj.position.set(box.position.x, h + 0.08, box.position.z);
          this.group.add(roofObj);

          // RES-01 residential yard fence + propSetIndex feature (garden bed, garage, or pool/shed)
          if (z.zoneKind === "RES-01") {
            const yard = this.buildResidentialYardProps(
              step - 0.25,
              step - 0.25,
              vis?.propSetIndex ?? ((gx + gz) % 3),
              zoneClass
            );
            yard.position.set(lotCx, 0.08, lotCz);
            this.group.add(yard);
          }
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

    // 2. Render Placed Catalog Buildings (`EXT`, `PRO`, `CMP`, `ASM`, `ENG`, `CIV`, `BIZ`, `MEG`, etc.)
    for (const b of buildings) {
      const entry =
        catalogs.buildingsById.get(b.catalogId) ??
        (b.catalogId.startsWith("MEG-") ? catalogs.buildingsById.get("MEG-02") : undefined);
      const secId: SectorId = b.sectorId === "core" ? 5 : b.sectorId;
      const bDistrictClass: DistrictClassId =
        (b as { districtClass?: DistrictClassId }).districtClass ??
        this.nearestDistrictClass(b.tileX + b.width * 0.5, b.tileY + b.depth * 0.5, zones, districts);
      const vis = entry
        ? pickBuildingVisual(b.id, entry, catalogs.visuals, secId, bDistrictClass)
        : null;

      const cx = b.tileX + b.width * 0.5;
      const cz = b.tileY + b.depth * 0.5;
      const underConstruction = b.stalledAwaitingPrivate || b.constructionProgress < 1;
      const upgrading = !!b.upgradeTargetLevel;

      const buildingContainer = new THREE.Group();
      buildingContainer.position.set(cx, 0, cz);
      buildingContainer.rotation.y = (-b.orientationDeg * Math.PI) / 180;
      buildingContainer.userData = { buildingId: b.id };

      // Concrete foundation pad (or green lawn for parks)
      const isPark = b.catalogId === "CIV-03" || entry?.visualFamily === "PARK";
      const padColor =
        b.id === selectedBuildingId
          ? 0x38bdf8
          : overlay === "pollution" && (entry?.pollution ?? 0) >= 2
            ? 0xef4444
            : isPark
              ? 0x15803d
              : 0x64748b;
      const padGeo = new THREE.BoxGeometry(b.width, 0.2, b.depth);
      const padMat = new THREE.MeshLambertMaterial({ color: padColor });
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.position.y = 0.1;
      pad.receiveShadow = true;
      pad.userData = { buildingId: b.id };
      addCrispOutline(pad, 0.32);
      buildingContainer.add(pad);

      if (isPark && !underConstruction) {
        this.populateParkLot(buildingContainer, b.width, b.depth, bDistrictClass, b.id);
        this.group.add(buildingContainer);
        continue;
      }

      const brandSpec = vis?.brandId
        ? catalogs.visuals.brands.find((br) => br.brandId === vis.brandId)
        : undefined;

      // Special layout for Filling Stations (`BIZ-09` / `FUEL` / `BR-FUEL-01..07`)
      if ((b.catalogId === "BIZ-09" || entry?.visualFamily === "FUEL") && !underConstruction) {
        this.populateFuelStation(buildingContainer, b, vis, brandSpec);
        this.group.add(buildingContainer);
        continue;
      }

      const baseFloors = Math.max(1, vis?.floors ?? 3);
      const fullHeight = Math.max(1.8, Math.min(22, baseFloors * 0.72 + (b.level - 1) * 1.05));
      const curHeight = underConstruction
        ? Math.max(1.1, fullHeight * Math.max(0.25, b.constructionProgress))
        : fullHeight;

      const hasForecourtParking =
        b.catalogId === "BIZ-10" ||
        b.catalogId === "BIZ-11" ||
        b.catalogId === "FIN-01" ||
        entry?.visualFamily === "SUPERMARKET" ||
        entry?.visualFamily === "BANK";

      const bw = Math.max(1.2, b.width * 0.8);
      const bd = Math.max(1.2, b.depth * (hasForecourtParking ? 0.64 : 0.78));
      const bodyZOffset = hasForecourtParking ? -b.depth * 0.1 : 0;

      const groundStyle = classifyGroundFloor(
        b.catalogId,
        entry?.visualFamily ?? "SINGLE-MODEL",
        baseFloors + b.level - 1
      );
      const tex = this.getFacadeTexture(
        vis?.wallHex ?? "#d6d3d1",
        vis?.accentHex ?? "#f59e0b",
        baseFloors + b.level - 1,
        vis?.facadeName ?? "Concrete",
        vis?.wearState ?? "new",
        groundStyle
      );
      const wallMat = new THREE.MeshLambertMaterial({ map: tex });
      const topCapMat = new THREE.MeshLambertMaterial({ color: vis?.roofHex ?? "#334155" });
      const bodyGeo = new THREE.BoxGeometry(bw, curHeight, bd);
      const body = new THREE.Mesh(bodyGeo, [
        wallMat,
        wallMat,
        topCapMat,
        topCapMat,
        wallMat,
        wallMat,
      ]);
      body.position.set(0, curHeight * 0.5 + 0.2, bodyZOffset);
      body.castShadow = true;
      body.receiveShadow = true;
      body.userData = { buildingId: b.id };
      addCrispOutline(body, 0.44);
      buildingContainer.add(body);

      if (!underConstruction) {
        const roofChoice = this.resolveRoofChoice(vis, entry, bDistrictClass, baseFloors + b.level - 1);
        const roofObj = buildRoofMesh(
          roofChoice,
          bw,
          bd,
          vis?.roofHex ?? "#334155",
          vis?.accentHex ?? "#f59e0b",
          {
            floors: baseFloors + b.level - 1,
            isLowRiseHouse: b.catalogId === "RES-01",
            seed: hashString32(b.id, 11),
          }
        );
        roofObj.position.set(0, curHeight + 0.2, bodyZOffset);
        buildingContainer.add(roofObj);

        if (hasForecourtParking) {
          this.populateBrandedRetailFront(buildingContainer, b, bw, bd, curHeight, bodyZOffset, brandSpec, vis);
        }

        if (b.catalogId === "RES-01") {
          const yard = this.buildResidentialYardProps(
            b.width * 0.94,
            b.depth * 0.94,
            vis?.propSetIndex ?? 0,
            bDistrictClass
          );
          yard.position.y = 0.2;
          buildingContainer.add(yard);
        }

        this.populateIndustrialSilhouettes(buildingContainer, b, entry, bw, bd, curHeight);
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

  private nearestDistrictClass(
    tx: number,
    ty: number,
    zones: readonly ZoneDto[],
    districts: ReadonlyMap<string, DistrictDto>
  ): DistrictClassId {
    let bestD = 45;
    let best: DistrictClassId = "M";
    for (const z of zones) {
      const d = Math.hypot(tx - (z.x + z.width * 0.5), ty - (z.y + z.depth * 0.5));
      if (d < bestD) {
        const dto = districts.get(z.id);
        if (dto) {
          bestD = d;
          best = dto.visualClass;
        }
      }
    }
    return best;
  }

  private buildResidentialYardProps(
    lotW: number,
    lotD: number,
    propSetIndex: number,
    districtClass: DistrictClassId
  ): THREE.Group {
    const yard = new THREE.Group();
    const fenceColor = districtClass === "R" ? 0xe2e8f0 : districtClass === "M" ? 0x15803d : 0x78350f;
    const fenceMat = new THREE.MeshLambertMaterial({ color: fenceColor });
    const fH = 0.24;
    const fT = 0.08;

    for (const [sx, sz, px, pz] of [
      [lotW, fT, 0, -lotD * 0.5],
      [lotW * 0.65, fT, -lotW * 0.17, lotD * 0.5],
      [fT, lotD, -lotW * 0.5, 0],
      [fT, lotD, lotW * 0.5, 0],
    ] as const) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(sx, fH, sz), fenceMat.clone());
      rail.position.set(px, fH * 0.5, pz);
      yard.add(rail);
    }
    fenceMat.dispose();

    const kind = propSetIndex % 3;
    if (kind === 0) {
      // Garden bed / flower patch
      const bed = new THREE.Mesh(
        new THREE.BoxGeometry(lotW * 0.36, 0.08, lotD * 0.22),
        new THREE.MeshLambertMaterial({ color: 0x16a34a })
      );
      bed.position.set(-lotW * 0.22, 0.05, lotD * 0.3);
      yard.add(bed);
      const bloom = new THREE.Mesh(
        new THREE.BoxGeometry(lotW * 0.24, 0.06, 0.12),
        new THREE.MeshLambertMaterial({ color: 0xf43f5e })
      );
      bloom.position.set(-lotW * 0.22, 0.11, lotD * 0.3);
      yard.add(bloom);
    } else if (kind === 1) {
      // Detached yard garage + driveway apron
      const garage = new THREE.Mesh(
        new THREE.BoxGeometry(0.76, 0.58, 0.92),
        new THREE.MeshLambertMaterial({ color: 0x94a3b8 })
      );
      garage.position.set(lotW * 0.26, 0.29, lotD * 0.24);
      garage.castShadow = true;
      addCrispOutline(garage, 0.38);
      yard.add(garage);
    } else {
      // Rich villa pool or cozy wooden garden shed
      const prop = new THREE.Mesh(
        new THREE.BoxGeometry(0.75, districtClass === "R" ? 0.07 : 0.48, 0.55),
        new THREE.MeshLambertMaterial({ color: districtClass === "R" ? 0x38bdf8 : 0x92400e })
      );
      prop.position.set(-lotW * 0.22, districtClass === "R" ? 0.04 : 0.24, lotD * 0.28);
      if (districtClass !== "R") addCrispOutline(prop, 0.35);
      yard.add(prop);
    }
    return yard;
  }

  private populateParkLot(
    container: THREE.Group,
    width: number,
    depth: number,
    districtClass: DistrictClassId,
    id: string
  ): void {
    const pathMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
    const p1 = new THREE.Mesh(new THREE.BoxGeometry(width * 0.92, 0.05, 0.55), pathMat);
    p1.position.y = 0.23;
    container.add(p1);
    const p2 = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.05, depth * 0.92), pathMat.clone());
    p2.position.y = 0.23;
    container.add(p2);

    const basin = new THREE.Mesh(
      new THREE.CylinderGeometry(Math.min(width, depth) * 0.18, Math.min(width, depth) * 0.2, 0.28, 12),
      new THREE.MeshLambertMaterial({ color: districtClass === "P" ? 0x94a3b8 : 0x38bdf8 })
    );
    basin.position.y = 0.32;
    addCrispOutline(basin, 0.36);
    container.add(basin);

    const h = hashString32(id, 5);
    const corners: readonly [number, number][] = [
      [-width * 0.3, -depth * 0.3],
      [width * 0.3, -depth * 0.3],
      [-width * 0.3, depth * 0.3],
      [width * 0.3, depth * 0.3],
    ];
    corners.forEach(([tx, tz], idx) => {
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.12, 0.55, 5),
        new THREE.MeshLambertMaterial({ color: 0x78350f })
      );
      trunk.position.set(tx, 0.45, tz);
      container.add(trunk);
      const autumn = ((h + idx) % 4) === 0;
      const crown = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.55, 0),
        new THREE.MeshLambertMaterial({ color: autumn ? 0xea580c : 0x22c55e, flatShading: true })
      );
      crown.position.set(tx, 0.95, tz);
      crown.castShadow = true;
      container.add(crown);
    });
  }

  /** Filling station (`BIZ-09`, `BR-FUEL-01..07`): rear shop + columned brand canopy + roadside price totem. */
  private populateFuelStation(
    container: THREE.Group,
    b: BuildingDto,
    vis: ResolvedBuildingVisual | null,
    brand: CorporateBrandSpec | undefined
  ): void {
    const primary = brand?.primaryHex ?? vis?.wallHex ?? "#2563eb";
    const secondary = brand?.secondaryHex ?? vis?.accentHex ?? "#ffffff";

    // Rear convenience kiosk
    const shopW = b.width * 0.68;
    const shopD = b.depth * 0.32;
    const shopTex = this.getFacadeTexture("#f1f5f9", primary, 1, "Glass curtain", vis?.wearState ?? "new", "retail");
    const shop = new THREE.Mesh(
      new THREE.BoxGeometry(shopW, 1.35, shopD),
      new THREE.MeshLambertMaterial({ map: shopTex })
    );
    shop.position.set(0, 0.88, -b.depth * 0.26);
    shop.castShadow = true;
    addCrispOutline(shop, 0.42);
    container.add(shop);

    // Forecourt canopy on 4 steel columns over fuel pumps
    const canW = b.width * 0.76;
    const canD = b.depth * 0.44;
    const canZ = b.depth * 0.14;
    const canopy = new THREE.Mesh(
      new THREE.BoxGeometry(canW, 0.34, canD),
      new THREE.MeshLambertMaterial({ color: primary })
    );
    canopy.position.set(0, 2.15, canZ);
    canopy.castShadow = true;
    addCrispOutline(canopy, 0.45);
    container.add(canopy);

    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(canW + 0.04, 0.1, canD + 0.04),
      new THREE.MeshLambertMaterial({ color: secondary })
    );
    stripe.position.set(0, 2.15, canZ);
    container.add(stripe);

    const colMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.95, 6), colMat.clone());
        col.position.set(sx * canW * 0.38, 1.15, canZ + sz * canD * 0.34);
        container.add(col);
      }
      // Fuel dispenser island
      const pump = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.62, 0.55),
        new THREE.MeshLambertMaterial({ color: secondary })
      );
      pump.position.set(sx * canW * 0.2, 0.51, canZ);
      addCrispOutline(pump, 0.38);
      container.add(pump);
    }
    colMat.dispose();

    // Roadside price totem stele
    const totem = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 2.75, 0.2),
      new THREE.MeshLambertMaterial({ color: primary })
    );
    totem.position.set(-b.width * 0.4, 1.55, b.depth * 0.4);
    totem.castShadow = true;
    addCrispOutline(totem, 0.45);
    container.add(totem);

    const ledBoard = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.95, 0.24),
      new THREE.MeshBasicMaterial({ color: secondary })
    );
    ledBoard.position.set(-b.width * 0.4, 1.95, b.depth * 0.4);
    container.add(ledBoard);
  }

  /** Branded 3D entrance frieze + front asphalt parking stalls for `BIZ-10`, `BIZ-11`, `FIN-01`. */
  private populateBrandedRetailFront(
    container: THREE.Group,
    b: BuildingDto,
    bw: number,
    bd: number,
    curHeight: number,
    bodyZOffset: number,
    brand: CorporateBrandSpec | undefined,
    vis: ResolvedBuildingVisual | null
  ): void {
    const primary = brand?.primaryHex ?? vis?.wallHex ?? "#2563eb";
    const secondary = brand?.secondaryHex ?? vis?.accentHex ?? "#facc15";
    const frontZ = bodyZOffset + bd * 0.5;

    // Projecting 3D branded frieze sign over main entrance
    const frieze = new THREE.Mesh(
      new THREE.BoxGeometry(bw * 0.64, 0.52, 0.34),
      new THREE.MeshLambertMaterial({ color: primary })
    );
    frieze.position.set(0, Math.min(curHeight * 0.78, 1.85), frontZ + 0.16);
    addCrispOutline(frieze, 0.44);
    container.add(frieze);

    const emblem = new THREE.Mesh(
      new THREE.BoxGeometry(bw * 0.48, 0.18, 0.38),
      new THREE.MeshBasicMaterial({ color: secondary })
    );
    emblem.position.set(0, Math.min(curHeight * 0.78, 1.85), frontZ + 0.17);
    container.add(emblem);

    // Asphalt parking apron + crisp white stall lines
    const parkD = Math.max(0.8, b.depth * 0.24);
    const parkZ = b.depth * 0.5 - parkD * 0.55;
    const apron = new THREE.Mesh(
      new THREE.BoxGeometry(bw * 0.94, 0.04, parkD),
      new THREE.MeshLambertMaterial({ color: 0x334155 })
    );
    apron.position.set(0, 0.22, parkZ);
    container.add(apron);

    const stalls = Math.max(3, Math.min(7, Math.floor(bw / 1.1)));
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0xf8fafc });
    for (let i = 0; i <= stalls; i++) {
      const sx = -bw * 0.42 + (i / stalls) * bw * 0.84;
      const line = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, parkD * 0.78), stripeMat.clone());
      line.position.set(sx, 0.23, parkZ);
      container.add(line);
    }
    stripeMat.dispose();
  }

  /** Differentiates industrial & energy complexes by `catalogId` per TheoTown reference silhouettes. */
  private populateIndustrialSilhouettes(
    container: THREE.Group,
    b: BuildingDto,
    entry: BuildingCatalogEntry | undefined,
    bw: number,
    bd: number,
    curHeight: number
  ): void {
    const id = b.catalogId;

    // A. Mines & Quarries (`EXT-01`, `EXT-02`, `EXT-04`, `EXT-08`): headframe w/ sheaves, stepped pit, spoil heap, conveyor
    if (id === "EXT-01" || id === "EXT-02" || id === "EXT-04" || id === "EXT-08") {
      // Stepped quarry pit
      const pitOuter = new THREE.Mesh(
        new THREE.BoxGeometry(bw * 0.44, 0.28, bd * 0.44),
        new THREE.MeshLambertMaterial({ color: 0x44403c })
      );
      pitOuter.position.set(-bw * 0.22, 0.22, bd * 0.22);
      addCrispOutline(pitOuter, 0.4);
      container.add(pitOuter);

      const pitInner = new THREE.Mesh(
        new THREE.BoxGeometry(bw * 0.26, 0.16, bd * 0.26),
        new THREE.MeshLambertMaterial({ color: 0x1c1917 })
      );
      pitInner.position.set(-bw * 0.22, 0.34, bd * 0.22);
      container.add(pitInner);

      // Conical spoil heap (отвал породы)
      const spoilColor = id === "EXT-01" ? 0x9a3412 : id === "EXT-02" ? 0x1e293b : 0xa8a29e;
      const heap = new THREE.Mesh(
        new THREE.ConeGeometry(Math.min(bw, bd) * 0.18, curHeight * 0.65, 7),
        new THREE.MeshLambertMaterial({ color: spoilColor, flatShading: true })
      );
      heap.position.set(bw * 0.28, curHeight * 0.32 + 0.2, bd * 0.24);
      heap.castShadow = true;
      addCrispOutline(heap, 0.35);
      container.add(heap);

      // Steel mine headframe (копёр со шкивами)
      const hfH = curHeight * 1.45;
      const steelMat = new THREE.MeshLambertMaterial({ color: 0x334155 });
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.85, hfH, 4), steelMat);
      tower.rotation.y = Math.PI * 0.25;
      tower.position.set(bw * 0.22, hfH * 0.5 + 0.2, -bd * 0.22);
      tower.castShadow = true;
      addCrispOutline(tower, 0.45);
      container.add(tower);

      const sheave = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.45, 0.14, 12),
        new THREE.MeshLambertMaterial({ color: 0xdc2626 })
      );
      sheave.rotation.x = Math.PI * 0.5;
      sheave.position.set(bw * 0.22, hfH + 0.35, -bd * 0.22);
      container.add(sheave);

      // Inclined conveyor gallery
      const convLen = Math.hypot(bw * 0.44, hfH * 0.65);
      const conveyor = new THREE.Mesh(
        new THREE.BoxGeometry(convLen, 0.36, 0.44),
        new THREE.MeshLambertMaterial({ color: 0x64748b })
      );
      conveyor.position.set(0, hfH * 0.42 + 0.2, -bd * 0.22);
      conveyor.rotation.z = 0.36;
      addCrispOutline(conveyor, 0.38);
      container.add(conveyor);
      return;
    }

    // B. Oil/Gas, Petrochem, Chemical & Grain/Silo Tank Farms (`EXT-03`, `EXT-05`, `EXT-07`, `PRO-02`, `PRO-03`, `PRO-05`, `PRO-06`, `ENG-06`, `INF-10`)
    if (
      id === "EXT-03" ||
      id === "EXT-05" ||
      id === "EXT-07" ||
      id === "PRO-02" ||
      id === "PRO-03" ||
      id === "PRO-05" ||
      id === "PRO-06" ||
      id === "ENG-06" ||
      id === "INF-10"
    ) {
      const tankMat = new THREE.MeshLambertMaterial({ color: 0xf1f5f9 });
      const rSphere = Math.max(0.48, Math.min(1.35, Math.min(bw, bd) * 0.14));

      // Spherical gas holders (Hortonspheres) + cylindrical storage tanks
      for (let i = 0; i < 2; i++) {
        const sx = -bw * 0.28 + i * rSphere * 2.3;
        const sz = bd * 0.28;
        if (id === "PRO-05" || id === "PRO-06") {
          const silo = new THREE.Mesh(
            new THREE.CylinderGeometry(rSphere * 0.78, rSphere * 0.78, curHeight * 0.95, 10),
            new THREE.MeshLambertMaterial({ color: id === "PRO-06" ? 0xd97706 : 0xe2e8f0 })
          );
          silo.position.set(sx, curHeight * 0.48 + 0.2, sz);
          silo.castShadow = true;
          addCrispOutline(silo, 0.38);
          container.add(silo);
        } else {
          const sphere = new THREE.Mesh(new THREE.SphereGeometry(rSphere, 12, 10), tankMat.clone());
          sphere.position.set(sx, rSphere + 0.35, sz);
          sphere.castShadow = true;
          addCrispOutline(sphere, 0.34);
          container.add(sphere);
        }
      }
      tankMat.dispose();

      // Cylindrical storage drum
      const drum = new THREE.Mesh(
        new THREE.CylinderGeometry(rSphere * 0.95, rSphere * 0.95, curHeight * 0.7, 12),
        new THREE.MeshLambertMaterial({ color: 0xcbd5e1 })
      );
      drum.position.set(bw * 0.28, curHeight * 0.35 + 0.2, bd * 0.24);
      drum.castShadow = true;
      addCrispOutline(drum, 0.38);
      container.add(drum);

      // Elevated steel pipe rack (трубопроводная эстакада)
      const pipeRack = new THREE.Mesh(
        new THREE.BoxGeometry(bw * 0.76, 0.22, 0.38),
        new THREE.MeshLambertMaterial({ color: 0xf59e0b })
      );
      pipeRack.position.set(0, 1.15, bd * 0.12);
      addCrispOutline(pipeRack, 0.38);
      container.add(pipeRack);
      return;
    }

    // C. Steelworks, Cement & Thermal Power (`PRO-01`, `PRO-04`, `ENG-01`, `ENG-02`): hyperboloid cooling towers + striped stacks
    if (id === "PRO-01" || id === "PRO-04" || id === "ENG-01" || id === "ENG-02") {
      // Hyperboloid cooling tower via LatheGeometry
      const ctH = Math.max(2.6, curHeight * 1.15);
      const rBase = Math.max(0.8, Math.min(2.1, Math.min(bw, bd) * 0.16));
      const pts = [
        new THREE.Vector2(rBase, 0),
        new THREE.Vector2(rBase * 0.82, ctH * 0.32),
        new THREE.Vector2(rBase * 0.66, ctH * 0.68),
        new THREE.Vector2(rBase * 0.76, ctH),
      ];
      const latheGeo = new THREE.LatheGeometry(pts, 14);
      const ct = new THREE.Mesh(latheGeo, new THREE.MeshLambertMaterial({ color: 0xcbd5e1, side: THREE.DoubleSide }));
      ct.position.set(-bw * 0.26, 0.2, -bd * 0.22);
      ct.castShadow = true;
      addCrispOutline(ct, 0.4);
      container.add(ct);

      // 2–3 tall red-and-white striped smokestacks
      const stackCount = id === "ENG-01" || id === "PRO-01" ? 3 : 2;
      const stackH = curHeight * 1.55;
      const bands = 5;
      const bandH = stackH / bands;
      for (let s = 0; s < stackCount; s++) {
        const sx = bw * 0.16 + s * 0.85;
        const sz = -bd * 0.26;
        for (let seg = 0; seg < bands; seg++) {
          const t0 = seg / bands;
          const t1 = (seg + 1) / bands;
          const rBot = 0.36 * (1 - t0 * 0.35);
          const rTop = 0.36 * (1 - t1 * 0.35);
          const band = new THREE.Mesh(
            new THREE.CylinderGeometry(rTop, rBot, bandH, 10),
            new THREE.MeshLambertMaterial({ color: seg % 2 === 0 ? 0xdc2626 : 0xf8fafc })
          );
          band.position.set(sx, 0.2 + (seg + 0.5) * bandH, sz);
          band.castShadow = true;
          container.add(band);
        }
      }
      return;
    }

    // D. Clean Energy / Substations & Solar-Wind Nodes (`ENG-03`, `ENG-04`, `ENG-05`)
    if (id === "ENG-03" || id === "ENG-04" || id === "ENG-05") {
      // Wind turbine mast + animated 3-blade rotor
      const mastH = Math.max(3.6, curHeight * 1.65);
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.2, mastH, 8),
        new THREE.MeshLambertMaterial({ color: 0xf8fafc })
      );
      mast.position.set(-bw * 0.28, mastH * 0.5 + 0.2, -bd * 0.24);
      mast.castShadow = true;
      addCrispOutline(mast, 0.36);
      container.add(mast);

      const rotorPivot = new THREE.Group();
      rotorPivot.position.set(-bw * 0.28, mastH + 0.2, -bd * 0.24 + 0.16);
      const hub = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 8, 8),
        new THREE.MeshLambertMaterial({ color: 0xe2e8f0 })
      );
      rotorPivot.add(hub);

      const bladeLen = Math.max(1.2, mastH * 0.44);
      const bladeMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      for (let bIdx = 0; bIdx < 3; bIdx++) {
        const holder = new THREE.Group();
        holder.rotation.z = (bIdx * Math.PI * 2) / 3;
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.14, bladeLen, 0.04), bladeMat.clone());
        blade.position.y = bladeLen * 0.5;
        holder.add(blade);
        rotorPivot.add(holder);
      }
      bladeMat.dispose();
      container.add(rotorPivot);
      this.windRotors.push(rotorPivot);

      // Angled rows of deep-blue photovoltaic solar panels
      const solarMat = new THREE.MeshLambertMaterial({ color: 0x1d4ed8 });
      for (let row = 0; row < 2; row++) {
        const panel = new THREE.Mesh(
          new THREE.BoxGeometry(bw * 0.56, 0.07, 0.58),
          solarMat.clone()
        );
        panel.position.set(bw * 0.16, 0.52, -0.35 + row * 0.85);
        panel.rotation.x = 0.45;
        addCrispOutline(panel, 0.35);
        container.add(panel);
      }
      solarMat.dispose();
      return;
    }

    // G. Megaproject landmarks (`MEG-01..04`): toroidal collider / fusion ring + spire
    if (id.startsWith("MEG-")) {
      const ringRadius = Math.min(bw, bd) * 0.36;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(ringRadius, Math.max(0.45, ringRadius * 0.14), 10, 24),
        new THREE.MeshLambertMaterial({ color: id === "MEG-04" ? 0x38bdf8 : id === "MEG-02" ? 0xa855f7 : 0xf59e0b })
      );
      ring.rotation.x = Math.PI * 0.5;
      ring.position.set(0, curHeight * 0.45 + 0.35, 0);
      addCrispOutline(ring, 0.42);
      container.add(ring);
      return;
    }

    // Fallback auxiliary industrial vent stack for other `EXT` / `CMP` / `ASM` plants
    if (entry && (entry.prefix === "EXT" || entry.prefix === "CMP" || entry.prefix === "ASM")) {
      const stack = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.4, curHeight * 0.55, 8),
        new THREE.MeshLambertMaterial({ color: 0x94a3b8 })
      );
      stack.position.set(bw * 0.3, curHeight + curHeight * 0.22, -bd * 0.26);
      stack.castShadow = true;
      addCrispOutline(stack, 0.38);
      container.add(stack);
    }
  }

  /** Tower crane (mast + slewing jib); stalled cranes are orange and do not slew. */
  private createCrane(mastHeight: number, jibLength: number, stalled: boolean): THREE.Group {
    const craneMat = new THREE.MeshLambertMaterial({ color: stalled ? 0xf59e0b : 0xfacc15 });
    const crane = new THREE.Group();
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.45, mastHeight, 0.45), craneMat);
    mast.position.y = mastHeight * 0.5;
    addCrispOutline(mast, 0.35);
    crane.add(mast);
    const boomPivot = new THREE.Group();
    boomPivot.position.y = mastHeight;
    const jib = new THREE.Mesh(new THREE.BoxGeometry(jibLength, 0.32, 0.32), craneMat.clone());
    jib.position.x = Math.max(1.5, jibLength * 0.35);
    addCrispOutline(jib, 0.35);
    boomPivot.add(jib);
    crane.add(boomPivot);
    this.cranes.push({ boom: boomPivot, stalled });
    return crane;
  }

  /** Delta-time animation step (rotates wind turbine 3-blade rotors and active tower cranes). */
  public update(dt: number): void {
    this.internalElapsed += dt;
    this.updateAnimations(this.internalElapsed);
  }

  public updateAnimations(elapsedSeconds: number): void {
    this.internalElapsed = elapsedSeconds;
    for (let i = 0; i < this.cranes.length; i++) {
      const c = this.cranes[i]!;
      if (!c.stalled) {
        c.boom.rotation.y = Math.sin(elapsedSeconds * 0.8 + i) * 0.9;
      }
    }
    for (let i = 0; i < this.windRotors.length; i++) {
      this.windRotors[i]!.rotation.z = -elapsedSeconds * 2.4 - i * 0.7;
    }
  }
}
