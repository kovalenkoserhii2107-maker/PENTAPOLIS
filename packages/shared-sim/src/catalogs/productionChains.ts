/**
 * 24-Commodity Production Chains across Tiers 1–4 (Sheet 16: `Production Chains`, GDD §4.1–4.2).
 */
import {
  normalizeCommodityName,
  parseCsv,
  parseNum,
  parseRecipeInputs,
  type MaterialRequirement,
} from "../csv.ts";
import { money, type Money } from "../money/money.ts";

export type ProductionTier = 1 | 2 | 3 | 4;

export interface CommodityRecipe {
  readonly id: string;
  readonly name: string;
  readonly tier: ProductionTier;
  readonly inputs: readonly MaterialRequirement[];
  readonly processingFacility: string;
  readonly transportModes: readonly string[];
  readonly worldReferencePrice: Money; // in minor units of WCU
  readonly worldReferencePriceUnits: number;
  readonly cycleSeconds: number;
  readonly grossSalesPerRealMinuteLv1: number;
  readonly gasSynergyDescription: string;
  readonly gasOutputBoostMultiplier: number; // e.g. 1.40 for +40%
  readonly gasEnergyCostMultiplier: number; // e.g. 0.75 for -25%
  readonly accountingUnit: string;
  readonly outputPerGameHourLv1: number;
  readonly materialInputCostUnits: number;
  readonly valueAddedUnits: number;
  readonly valueAddedMargin: number;
  readonly valueAddedPerGameHourLv1: number;
}

function slugifyCommodity(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function parseGasBoost(desc: string): { outputMult: number; energyCostMult: number } {
  const boostMatch = /\+(\d+(?:\.\d+)?)\s*%/i.exec(desc);
  const costMatch = /-(\d+(?:\.\d+)?)\s*%\s*(?:smelting\s+|thermal\s+)?(?:energy\s+)?cost/i.exec(
    desc
  );
  // Tier 1 raw mineral deposits describe downstream synergy rather than own plant boost,
  // except Grain farms (+35% yield via Fertilizers) which is handled via fertilizer input.
  if (/^none\b|^shared\b|^dual-fuel\b|^primary catalyst\b/i.test(desc.trim())) {
    return { outputMult: 1.0, energyCostMult: 1.0 };
  }
  return {
    outputMult: boostMatch ? 1 + parseFloat(boostMatch[1]!) / 100 : 1.0,
    energyCostMult: costMatch ? 1 - parseFloat(costMatch[1]!) / 100 : 0.75,
  };
}

export function parseProductionChainsSheet(csvText: string): CommodityRecipe[] {
  const rows = parseCsv(csvText);
  const recipes: CommodityRecipe[] = [];

  for (let i = 5; i < rows.length; i++) {
    const r = rows[i]!;
    const rawName = (r[1] ?? "").trim();
    const tierStr = (r[2] ?? "").trim();
    const tierMatch = /^Tier\s+([1-4])$/i.exec(tierStr);
    if (!rawName || !tierMatch) continue;

    const name = normalizeCommodityName(rawName);
    const tier = parseInt(tierMatch[1]!, 10) as ProductionTier;
    const priceUnits = parseNum(r[6]);
    const gasDesc = (r[9] ?? "").trim();
    const gas = parseGasBoost(gasDesc);

    recipes.push({
      id: slugifyCommodity(name),
      name,
      tier,
      inputs: parseRecipeInputs(r[3]),
      processingFacility: (r[4] ?? "").trim(),
      transportModes: (r[5] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      worldReferencePrice: money(priceUnits),
      worldReferencePriceUnits: priceUnits,
      cycleSeconds: parseNum(r[7]),
      grossSalesPerRealMinuteLv1: parseNum(r[8]),
      gasSynergyDescription: gasDesc,
      gasOutputBoostMultiplier: gas.outputMult,
      gasEnergyCostMultiplier: gas.energyCostMult,
      accountingUnit: (r[10] ?? "").trim(),
      outputPerGameHourLv1: parseNum(r[11]),
      materialInputCostUnits: parseNum(r[12]),
      valueAddedUnits: parseNum(r[13]),
      valueAddedMargin: parseNum(r[14]),
      valueAddedPerGameHourLv1: parseNum(r[15]),
    });
  }

  return recipes;
}
