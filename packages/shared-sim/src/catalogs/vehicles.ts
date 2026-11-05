/**
 * Master Vehicle Catalog — 56 Vehicle Types, Zero Marshrutkas (Sheet 07: `Vehicle Catalog`, GDD §5.4, §7).
 */
import { parseCsv, parseNum } from "../csv.ts";
import { money, type Money } from "../money/money.ts";
import type { DevelopmentStageId } from "./buildings.ts";

export type VehicleTransportMode =
  | "Road"
  | "Road + overhead wire"
  | "Tram track"
  | "Metro"
  | "Rail"
  | "Water"
  | "Air";

export interface VehicleCatalogEntry {
  readonly id: string;
  readonly nameEn: string;
  readonly nameRu: string;
  readonly vehicleClass: string;
  readonly mode: VehicleTransportMode;
  readonly ownerType: string;
  readonly unlockStage: DevelopmentStageId;
  readonly purchasePrice: Money;
  readonly purchasePriceUnits: number;
  readonly capacity: number;
  readonly capacityUnit: string;
  readonly speedKmh: number;
  readonly fuelOrEnergy: string;
  readonly consumptionPer100Km: string;
  readonly runningCostPerKmUnits: number;
  readonly crew: number;
  readonly serviceLifeGameMonths: number;
  readonly roadWearFactor: number; // 1.0 = passenger car; heavy trucks up to 3000.0
  readonly needsInfrastructure: string;
  readonly depotBuildingIds: readonly string[];
  readonly builtFromBuildingId: string;
  readonly emissions: number; // 0..3
  readonly notes: string;
}

export function parseVehicleCatalogSheet(csvText: string): VehicleCatalogEntry[] {
  const rows = parseCsv(csvText);
  const vehicles: VehicleCatalogEntry[] = [];

  for (let i = 3; i < rows.length; i++) {
    const r = rows[i]!;
    const id = (r[1] ?? "").trim();
    if (!/^[A-Z]+-\d{2}$/.test(id)) continue;

    const priceUnits = parseNum(r[8]);
    const depotRaw = (r[19] ?? "").trim();
    const depotIds = depotRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[A-Z]{3}-\d{2}$/.test(s));

    vehicles.push({
      id,
      nameEn: (r[2] ?? "").trim(),
      nameRu: (r[3] ?? "").trim(),
      vehicleClass: (r[4] ?? "").trim(),
      mode: (r[5] ?? "Road").trim() as VehicleTransportMode,
      ownerType: (r[6] ?? "").trim(),
      unlockStage: ((r[7] ?? "S0").trim() || "S0") as DevelopmentStageId,
      purchasePrice: money(priceUnits),
      purchasePriceUnits: priceUnits,
      capacity: parseNum(r[9]),
      capacityUnit: (r[10] ?? "").trim(),
      speedKmh: parseNum(r[11]),
      fuelOrEnergy: (r[12] ?? "").trim(),
      consumptionPer100Km: (r[13] ?? "").trim(),
      runningCostPerKmUnits: parseNum(r[14]),
      crew: parseNum(r[15]),
      serviceLifeGameMonths: parseNum(r[16]),
      roadWearFactor: parseNum(r[17]),
      needsInfrastructure: (r[18] ?? "").trim(),
      depotBuildingIds: depotIds,
      builtFromBuildingId: (r[20] ?? "").trim(),
      emissions: parseNum(r[21]),
      notes: (r[22] ?? "").trim(),
    });
  }

  return vehicles;
}
