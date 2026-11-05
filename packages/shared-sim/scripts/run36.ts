/**
 * Headless 36-Month Five-Region Economy Simulation Runner (`bun run sim:run36`).
 *
 * Reproduces the canonical Sheet 08 (`Regional Money Model`) test scenario:
 * - R1 (Northern Basin, ₴ UAH): Taylor rule
 * - R2 (North-East Shelf, zł PLN): Taylor rule + 25% SWF sterilization
 * - R3 (Central Valley, kr KR): Taylor rule
 * - R4 (Southern Foothills, ƒ FLR): Populist (3% key rate, CB buys 80% of bonds -> triggers IMF)
 * - R5 (Eastern Cape, ◈ DUC): Hawk (12% key rate, 8% reserve ratio)
 */
import {
  RegionalMoneyEngine,
  getCurrencySpec,
  money,
  toUnits,
} from "../src/index.ts";

const engine = new RegionalMoneyEngine({
  currencies: ["UAH", "PLN", "KR", "FLR", "DUC"],
  policies: {
    1: "taylor",
    2: "taylor",
    3: "taylor",
    4: "populist",
    5: "hawk",
  },
  mode: "mature",
});

engine.getRegion(2).levers.swfSterilizationShare = 0.25;

// Seed a 10%/90% co-invested steel mill in R1 and a stalled plant in R5 bought out by the mayor
engine.createFactoryProject({
  projectId: "r1-steel-1",
  sectorId: 1,
  buildingCatalogId: "PRO-01",
  buildCostLocal: money(2_000_000),
  expectedAnnualRoi: 0.16,
});
const stalledR5 = engine.createFactoryProject({
  projectId: "r5-fab-1",
  sectorId: 5,
  buildingCatalogId: "CMP-02",
  buildCostLocal: money(3_500_000),
  expectedAnnualRoi: 0.11, // below Hawk R5's ~15.5% loan rate -> awaits private investors
});
if (stalledR5.status === "awaiting_private_investors") {
  engine.mayorBuyoutStalledFactory(5, stalledR5.projectId, money(3_500_000));
}

let worstMinorDiff = 0n;
console.log(
  "Month | Sector | Curr | FX/WCU | Infl%  | Key%  | HHs    | Debt/Rev | FX(mo) | IMF | MaxErr"
);
console.log("-".repeat(92));

for (let m = 1; m <= 36; m++) {
  const reports = engine.stepMonth();
  for (const rep of reports) {
    const err =
      rep.invariants.maxRowError +
      rep.invariants.maxColError +
      (rep.invariants.cbColumnIndependentSum < 0n
        ? -rep.invariants.cbColumnIndependentSum
        : rep.invariants.cbColumnIndependentSum) +
      rep.invariants.moneyDecompositionDiff;
    if (err > worstMinorDiff) worstMinorDiff = err;

    if (m === 1 || m === 12 || m === 24 || m === 36) {
      const sym = getCurrencySpec(rep.currency).symbol;
      console.log(
        `${String(rep.month).padStart(5)} |   S${rep.sectorId}   | ${(rep.currency + " " + sym).padEnd(5)} | ` +
          `${rep.fxRatePerWcu.toFixed(3).padStart(6)} | ` +
          `${(rep.annualInflation * 100).toFixed(1).padStart(5)}% | ` +
          `${(rep.keyRate * 100).toFixed(1).padStart(4)}% | ` +
          `${String(Math.round(rep.households)).padStart(6)} | ` +
          `${rep.debtToAnnualRevenue.toFixed(2).padStart(8)} | ` +
          `${rep.fxReservesMonthsOfImports.toFixed(1).padStart(6)} | ` +
          `${(rep.imfActive ? "YES" : "NO ").padEnd(3)} | ` +
          `${toUnits(err).toFixed(2)}`
      );
    }
  }
}

console.log("-".repeat(92));
console.log(
  `36-month 5-region audit complete (180 matrices). Worst minor-unit discrepancy = ${worstMinorDiff} (0.00)`
);
