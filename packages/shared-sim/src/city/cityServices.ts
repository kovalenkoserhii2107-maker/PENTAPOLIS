/**
 * District Micro-Economy: Services, Crime, Ecology, Land Value & Stratification (Sprint 6, GDD §6.3, §6.6).
 *
 * Every zone is a district cell. Its land value ($120 – $6,000 per tile, GDD §6.3) starts at the
 * zone's land-value floor (sheet 22) and is moved by:
 * - civic services covering it (police, fire, clinic, hospital, parks, schools — sheet 25 Table 6
 *   land-value boosts; coverage radius and capacity from the Building Catalog, diluted when more
 *   citizens depend on a station than it can serve);
 * - ecology: smoke from polluting plants within their plume (coal smoke −40..70%), parks and the
 *   Gas Subsidy decree clean the air (+30..80%);
 * - crime, cut by police (−45%) and the Night Curfew decree (−25%);
 * - metro stations (+25%, Sprint 5).
 * The value places the district in one of the 5 tiers of sheet 25 Table 5 (industrial outskirts →
 * elite enclave), which picks the visual class of its buildings and the residents it attracts.
 */
import { parseCsv, parseNum } from "../csv.ts";
import { RAW_SHEETS } from "../catalogs/rawSheets.generated.ts";
import type { MasterCatalogs } from "../catalogs/index.ts";
import { computeBuildingAtLevel } from "../catalogs/buildings.ts";
import type { DistrictClassId, SectorId } from "../catalogs/visuals.ts";
import type { ZoneKind } from "../map/PeninsulaGrid.ts";
import type { ActiveEmergencyDto, BuildingDto, DistrictDto, SectorCityStatsDto, ZoneDto } from "../protocol.ts";

export type ServiceKind = "police" | "fire" | "clinic" | "hospital" | "park" | "kindergarten" | "school" | "college" | "university";

export interface ServiceSpec {
  readonly kind: ServiceKind;
  readonly buildingId: string;
  readonly nameRu: string;
  /** Sheet 25 Table 6 row (land value boost, crime/hazard/pollution reduction), when the sheet lists it. */
  readonly landValueBoost: number;
  readonly reduction: number;
  /** Who the capacity counts: all residents, small children, pupils or students. */
  readonly servedGroup: "residents" | "children" | "pupils" | "students";
}

const TABLE6_ROWS: ReadonlyArray<readonly [RegExp, ServiceKind]> = [
  [/^police station/i, "police"],
  [/^municipal fire station/i, "fire"],
  [/^municipal outpatient clinic/i, "clinic"],
  [/^central hospital/i, "hospital"],
  [/^urban park/i, "park"],
];

const SERVICE_BUILDINGS: ReadonlyArray<readonly [ServiceKind, string, ServiceSpec["servedGroup"]]> = [
  ["police", "SAF-01", "residents"],
  ["fire", "SAF-02", "residents"],
  ["clinic", "HLT-01", "residents"],
  ["hospital", "HLT-02", "residents"],
  ["park", "CIV-03", "residents"],
  ["kindergarten", "EDU-01", "children"],
  ["school", "EDU-02", "pupils"],
  ["college", "EDU-03", "students"],
  ["university", "EDU-04", "students"],
];

export interface DistrictTierSpec {
  readonly tier: 1 | 2 | 3 | 4 | 5;
  readonly nameEn: string;
  readonly residentsEn: string;
  readonly baseCrimeRate: number;
  readonly ecologyIndex: number;
}

export const DISTRICT_TIER_NAMES_RU: Readonly<Record<1 | 2 | 3 | 4 | 5, string>> = {
  1: "Промышленные окраины",
  2: "Рабочий район",
  3: "Средний класс",
  4: "Зелёный престижный район",
  5: "Элитный анклав",
};

/** Land value per tile ($) at which a district enters tiers 2..5 (GDD §6.3 range $120..$6,000). */
export const TIER_LAND_VALUE_THRESHOLDS: readonly number[] = [250, 600, 1500, 3500];
export const LAND_VALUE_MIN = 120;
export const LAND_VALUE_MAX = 6000;

/** Tier -> visual class of buildings (sheet 06: Poor / Middle / Rich). */
export function districtClassForTier(tier: number): DistrictClassId {
  return tier <= 2 ? "P" : tier === 3 ? "M" : "R";
}

export interface CityServiceTables {
  readonly services: ReadonlyMap<ServiceKind, ServiceSpec>;
  readonly tiers: readonly DistrictTierSpec[];
  readonly landValueFloor: ReadonlyMap<ZoneKind, number>;
  readonly gasConversion: { readonly pollutionReduction: number; readonly landValueBoost: number };
}

const ZONE_ROWS: ReadonlyArray<readonly [RegExp, ZoneKind]> = [
  [/^low-density residential/i, "RES-01"],
  [/^medium-density residential/i, "RES-02"],
  [/^high-density residential/i, "RES-03"],
  [/^low-density commercial/i, "COM-01"],
  [/^medium-density commercial/i, "COM-02"],
  [/^high-density commercial/i, "COM-03"],
  [/^medium-density office/i, "OFF-01"],
  [/^high-density office/i, "OFF-02"],
];

export function parseCityServiceTables(
  urbanCsv: string,
  zoningCsv: string,
  catalogs: MasterCatalogs
): CityServiceTables {
  const rows = parseCsv(urbanCsv);
  const t5 = rows.findIndex((r) => (r[1] ?? "").startsWith("Table 5"));
  const t6 = rows.findIndex((r) => (r[1] ?? "").startsWith("Table 6"));

  const tiers: DistrictTierSpec[] = [];
  for (let i = t5 + 1; i < rows.length && tiers.length < 5; i++) {
    const r = rows[i]!;
    const m = /^Tier (\d)/.exec((r[1] ?? "").trim());
    if (!m) continue;
    tiers.push({
      tier: Number(m[1]) as DistrictTierSpec["tier"],
      nameEn: (r[1] ?? "").replace(/^Tier \d:\s*/, "").trim(),
      residentsEn: (r[2] ?? "").trim(),
      baseCrimeRate: parseNum(r[3]),
      ecologyIndex: parseNum(r[4]),
    });
  }

  const table6 = new Map<ServiceKind, { boost: number; reduction: number }>();
  let gasConversion = { pollutionReduction: 0.65, landValueBoost: 0.28 };
  for (let i = t6 + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const name = (r[1] ?? "").trim();
    if (!name) continue;
    const reduction = Math.abs(parseNum(r[5]));
    const boost = parseNum(r[6]);
    if (/^coal-to-gas/i.test(name)) gasConversion = { pollutionReduction: reduction, landValueBoost: boost };
    const match = TABLE6_ROWS.find(([re]) => re.test(name));
    if (match) table6.set(match[1], { boost, reduction });
  }

  const services = new Map<ServiceKind, ServiceSpec>();
  for (const [kind, buildingId, servedGroup] of SERVICE_BUILDINGS) {
    const entry = catalogs.buildingsById.get(buildingId);
    const row = table6.get(kind);
    services.set(kind, {
      kind,
      buildingId,
      nameRu: entry?.nameRu ?? buildingId,
      // Services the sheet does not list use the catalog's own land-value effect
      landValueBoost: row?.boost ?? Math.max(0, entry?.landValueEffect.percentDelta ?? 0),
      reduction: row?.reduction ?? 0,
      servedGroup,
    });
  }

  const landValueFloor = new Map<ZoneKind, number>();
  for (const r of parseCsv(zoningCsv)) {
    const match = ZONE_ROWS.find(([re]) => re.test((r[1] ?? "").trim()));
    if (match && !landValueFloor.has(match[1])) landValueFloor.set(match[1], parseNum(r[7]));
  }

  return { services, tiers, landValueFloor, gasConversion };
}

let cachedTables: CityServiceTables | null = null;

export function getCityServiceTables(catalogs: MasterCatalogs): CityServiceTables {
  if (!cachedTables) {
    cachedTables = parseCityServiceTables(
      RAW_SHEETS["Urban Micro-Economy & Auto"] ?? "",
      RAW_SHEETS["Zoning & Building Upgrades"] ?? "",
      catalogs
    );
    if (cachedTables.tiers.length !== 5 || cachedTables.landValueFloor.size !== 8) {
      throw new Error("Sheets 22/25 are missing district tiers or land-value floors");
    }
  }
  return cachedTables;
}

// ---------------------------------------------------------------------------------------------
// Demography constants for coverage demand (GDD §6.2 three-step education)
// ---------------------------------------------------------------------------------------------
const RESIDENTS_PER_TILE: Readonly<Record<string, number>> = { "RES-01": 0.55, "RES-02": 7, "RES-03": 27 };
const CHILDREN_0_6_PER_RESIDENT = 0.08;
const PUPILS_7_17_PER_RESIDENT = 0.12;
const STUDENTS_18_22_PER_RESIDENT = 0.05;
/** Base street crime before policing; unemployment pushes it up (sheet 25 Table 5 tiers 2–3). */
const BASE_CRIME = 0.14;
const CRIME_PER_HARDSHIP = 0.8;
const NIGHT_CURFEW_CRIME_MULTIPLIER = 0.75;
const BASE_ECOLOGY = 0.78;
/** Smoke plume: radius (tiles) and ecology loss at the source per pollution point (0..3). */
const PLUME_RADIUS_BASE = 10;
const PLUME_RADIUS_PER_POINT = 10;
const ECOLOGY_LOSS_PER_POINT = 0.16;
const GAS_SUBSIDY_POLLUTION_MULTIPLIER = 0.75;
/** Ecological emergencies hit the whole sector while active. */
const EMERGENCY_ECOLOGY_PENALTY: Readonly<Record<string, number>> = {
  COAL_SMOG: 0.25,
  RIVER_POLLUTION: 0.15,
  GARBAGE_COLLAPSE: 0.2,
};
export const METRO_LAND_VALUE_BOOST_SHARE = 0.25;

export interface CitySectorInput {
  readonly sectorId: SectorId;
  readonly activeDecreeIds: readonly string[];
  readonly hardshipShare: number;
}

export interface CityModelInput {
  readonly catalogs: MasterCatalogs;
  readonly zones: readonly ZoneDto[];
  readonly buildings: readonly BuildingDto[];
  readonly sectors: readonly CitySectorInput[];
  readonly emergencies: readonly ActiveEmergencyDto[];
  /** Zones within a working metro station's radius (Sprint 5 traffic model). */
  readonly metroZoneIds?: ReadonlySet<string>;
  /** Zones within a licensed bus stop's radius. */
  readonly busZoneIds?: ReadonlySet<string>;
}

export interface CityModelResult {
  readonly districts: readonly DistrictDto[];
  readonly sectors: readonly SectorCityStatsDto[];
}

interface Station {
  readonly kind: ServiceKind;
  readonly building: BuildingDto;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly capacity: number;
  demand: number;
}

const center = (x: number, y: number, w: number, d: number): [number, number] => [x + w / 2, y + d / 2];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function tierForLandValue(value: number): 1 | 2 | 3 | 4 | 5 {
  let tier = 1;
  for (const t of TIER_LAND_VALUE_THRESHOLDS) if (value >= t) tier += 1;
  return tier as 1 | 2 | 3 | 4 | 5;
}

/** Computes every district and the sector aggregates. Pure and deterministic. */
export function computeCityServices(input: CityModelInput): CityModelResult {
  const { catalogs } = input;
  const tables = getCityServiceTables(catalogs);
  const districts: DistrictDto[] = [];
  const sectors: SectorCityStatsDto[] = [];

  for (const sec of input.sectors) {
    const sid = sec.sectorId;
    const zones = input.zones.filter((z) => z.sectorId === sid);
    const operational = input.buildings.filter(
      (b) => b.sectorId === sid && b.constructionProgress >= 1 && !b.stalledAwaitingPrivate
    );
    const curfew = sec.activeDecreeIds.includes("NIGHT_CURFEW");
    const gasSubsidy = sec.activeDecreeIds.includes("GAS_SUBSIDY");

    // Stations with coverage radius and capacity (catalog, scaled by level)
    const stations: Station[] = [];
    for (const spec of tables.services.values()) {
      const entry = catalogs.buildingsById.get(spec.buildingId);
      if (!entry) continue;
      for (const b of operational) {
        if (b.catalogId !== spec.buildingId) continue;
        const stats = computeBuildingAtLevel(entry, catalogs.levelCurves, b.level);
        const [x, y] = center(b.tileX, b.tileY, b.width, b.depth);
        stations.push({
          kind: spec.kind,
          building: b,
          x,
          y,
          // Colleges & universities serve the whole sector (catalog radius 0)
          radius: entry.serviceRadiusTiles > 0 ? entry.serviceRadiusTiles : Infinity,
          capacity: stats.capacity,
          demand: 0,
        });
      }
    }

    const residents = (z: ZoneDto) => z.width * z.depth * (RESIDENTS_PER_TILE[z.zoneKind] ?? 0) * z.occupancyRatio;
    const groupDemand = (spec: ServiceSpec, r: number) =>
      spec.servedGroup === "children"
        ? r * CHILDREN_0_6_PER_RESIDENT
        : spec.servedGroup === "pupils"
          ? r * PUPILS_7_17_PER_RESIDENT
          : spec.servedGroup === "students"
            ? r * STUDENTS_18_22_PER_RESIDENT
            : r;
    const reaches = (s: Station, z: ZoneDto) => {
      const [zx, zy] = center(z.x, z.y, z.width, z.depth);
      return Math.hypot(zx - s.x, zy - s.y) <= s.radius + Math.max(z.width, z.depth) / 2;
    };

    // Pass 1: demand on each station from the residents in reach
    for (const z of zones) {
      const r = residents(z);
      if (r <= 0) continue;
      for (const s of stations) {
        if (reaches(s, z)) s.demand += groupDemand(tables.services.get(s.kind)!, r);
      }
    }

    const sectorEcoPenalty = input.emergencies
      .filter((e) => e.sectorId === sid)
      .reduce((p, e) => p + (EMERGENCY_ECOLOGY_PENALTY[e.emergencyId] ?? 0), 0);
    const heistCrime = input.emergencies.some((e) => e.sectorId === sid && e.emergencyId === "BANK_HEIST") ? 0.05 : 0;

    // Pass 2: per-district coverage, crime, ecology and land value
    let tileSum = 0;
    let valueSum = 0;
    let crimeSum = 0;
    let ecoSum = 0;
    let happySum = 0;
    let residentSum = 0;
    const covered: Record<ServiceKind, number> = {
      police: 0, fire: 0, clinic: 0, hospital: 0, park: 0, kindergarten: 0, school: 0, college: 0, university: 0,
    };
    const tierResidents = [0, 0, 0, 0, 0];
    let healthCovered = 0;

    for (const z of zones) {
      const coverage = {} as Record<ServiceKind, number>;
      for (const spec of tables.services.values()) {
        let best = 0;
        for (const s of stations) {
          if (s.kind !== spec.kind || !reaches(s, z)) continue;
          best = Math.max(best, s.demand > 0 ? Math.min(1, s.capacity / s.demand) : 1);
        }
        coverage[spec.kind] = best;
      }
      const health = Math.max(coverage.clinic, coverage.hospital);

      // Ecology: plumes of polluting buildings, cleaned by parks and gas subsidy
      const [zx, zy] = center(z.x, z.y, z.width, z.depth);
      let pollution = 1 - BASE_ECOLOGY;
      for (const b of operational) {
        const entry = catalogs.buildingsById.get(b.catalogId);
        const p = entry?.pollution ?? 0;
        if (p <= 0) continue;
        const plume = PLUME_RADIUS_BASE + PLUME_RADIUS_PER_POINT * p;
        // Smoke spreads from the plant's whole footprint, not just its centre
        const dx = Math.max(b.tileX - zx, 0, zx - (b.tileX + b.width));
        const dy = Math.max(b.tileY - zy, 0, zy - (b.tileY + b.depth));
        const d = Math.hypot(dx, dy);
        if (d < plume) pollution += p * ECOLOGY_LOSS_PER_POINT * (1 - d / plume);
      }
      if (gasSubsidy) pollution *= GAS_SUBSIDY_POLLUTION_MULTIPLIER;
      pollution *= 1 - tables.services.get("park")!.reduction * coverage.park;
      const ecology = clamp01(1 - pollution - sectorEcoPenalty);

      const crime = clamp01(
        (BASE_CRIME + sec.hardshipShare * CRIME_PER_HARDSHIP + heistCrime) *
          (1 - tables.services.get("police")!.reduction * coverage.police) *
          (curfew ? NIGHT_CURFEW_CRIME_MULTIPLIER : 1)
      );

      let boost = 0;
      for (const spec of tables.services.values()) boost += spec.landValueBoost * coverage[spec.kind];
      if (input.metroZoneIds?.has(z.id)) boost += METRO_LAND_VALUE_BOOST_SHARE;
      if (gasSubsidy) boost += tables.gasConversion.landValueBoost * 0.5;
      // Coal smoke takes −40..70%, clean air and parks add up to +30%
      const ecologyFactor = 0.3 + ecology;
      const crimeFactor = Math.max(0.3, 1 - crime * 1.5);
      const floor = tables.landValueFloor.get(z.zoneKind) ?? 300;
      const landValue = Math.round(
        Math.max(LAND_VALUE_MIN, Math.min(LAND_VALUE_MAX, floor * (1 + boost) * ecologyFactor * crimeFactor))
      );
      const tier = tierForLandValue(landValue);

      // District well-being for developers & residents (GDD §6.7 factor weights, services only)
      const transport = input.metroZoneIds?.has(z.id) ? 1 : input.busZoneIds?.has(z.id) ? 0.8 : 0.5;
      const education = z.zoneKind.startsWith("RES")
        ? (coverage.kindergarten + coverage.school) / 2
        : 0.7;
      const happiness = Math.round(
        100 *
          ((clamp01(1 - crime / 0.3) * 10 +
            health * 10 +
            education * 8 +
            ecology * 8 +
            transport * 8 +
            coverage.fire * 6) /
            50)
      );

      districts.push({
        zoneId: z.id,
        sectorId: sid,
        zoneKind: z.zoneKind,
        landValuePerTile: landValue,
        tier,
        tierNameRu: DISTRICT_TIER_NAMES_RU[tier],
        visualClass: districtClassForTier(tier),
        crimeRate: Number(crime.toFixed(3)),
        ecology: Number(ecology.toFixed(3)),
        happiness,
        coverage: {
          police: Number(coverage.police.toFixed(2)),
          fire: Number(coverage.fire.toFixed(2)),
          health: Number(health.toFixed(2)),
          park: Number(coverage.park.toFixed(2)),
          kindergarten: Number(coverage.kindergarten.toFixed(2)),
          school: Number(coverage.school.toFixed(2)),
          higherEducation: Number(Math.max(coverage.college, coverage.university).toFixed(2)),
        },
      });

      const tiles = z.width * z.depth;
      const r = residents(z);
      tileSum += tiles;
      valueSum += landValue * tiles;
      crimeSum += crime * tiles;
      ecoSum += ecology * tiles;
      happySum += happiness * tiles;
      residentSum += r;
      tierResidents[tier - 1]! += r;
      for (const k of Object.keys(covered) as ServiceKind[]) covered[k] += coverage[k] * r;
      healthCovered += health * r;
    }

    const share = (k: ServiceKind) => (residentSum > 0 ? Number((covered[k] / residentSum).toFixed(3)) : 0);
    sectors.push({
      sectorId: sid,
      districts: zones.length,
      residents: Math.round(residentSum),
      avgLandValuePerTile: tileSum > 0 ? Math.round(valueSum / tileSum) : 0,
      avgCrimeRate: tileSum > 0 ? Number((crimeSum / tileSum).toFixed(3)) : 0,
      avgEcology: tileSum > 0 ? Number((ecoSum / tileSum).toFixed(3)) : 1,
      districtHappiness: tileSum > 0 ? Math.round(happySum / tileSum) : 0,
      residentsByTier: tierResidents.map((v) => Math.round(v)),
      coverage: {
        police: share("police"),
        fire: share("fire"),
        health: residentSum > 0 ? Number((healthCovered / residentSum).toFixed(3)) : 0,
        park: share("park"),
        kindergarten: share("kindergarten"),
        school: share("school"),
        higherEducation: residentSum > 0 ? Number((Math.max(covered.college, covered.university) / residentSum).toFixed(3)) : 0,
      },
      stations: stations.map((s) => ({
        buildingId: s.building.id,
        kind: s.kind,
        capacity: Math.round(s.capacity),
        demand: Math.round(s.demand),
      })),
    });
  }

  return { districts, sectors };
}
