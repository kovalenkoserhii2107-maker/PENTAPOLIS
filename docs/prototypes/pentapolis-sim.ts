// Pentapolis headless economy simulator (prototype of packages/shared-sim).
// One step = one game month for the whole peninsula. Every month the full
// transaction-flow matrix is built and checked: every row and every column must sum to zero.
// Baseline numbers are copied from the "Money Flow Model" sheet.

type Cls = { name: string; n: number; wage: number; pension: number; housing: number;
  food: number; goods: number; util: number; transport: number; propTax: number;
  pit: number; divShare: number; insurance: number; leisure: number; deposits: number;
  floor: number };

const P0 = {
  vat: 0.10, corpTax: 0.18, payout: 0.60, stateEquity: 0.35,
  wageFirms: 0.80, wagePublic: 0.17, wageBanks: 0.03,
  exports: 260e6, imports: 245e6, importDuty: 0.06, exportDuty: 0.01,
  playerDuties: 7965790, tourism: 24e6, visa: 3.51e6,
  govContracts: 175e6, govPrograms: 9.1e6, subsidies: 4.9e6, eminent: 6e6,
  capex: 140e6, newHousing: 60e6, newMortgages: 25e6, firmDepChange: 10e6,
  migrantSavings: 2e6, spread: 0.005, shadowShare: 0.5, evadedDuties: 2481710,
  lossRatio: 0.65, wealthSpend: 0.004, mortDefault: 0.012, firmDefault: 0.025,
  minCapital: 0.08,
};

const classes: Cls[] = [
  { name: "Workers", n: 148750, wage: 2200, pension: 0, housing: 600, food: 550, goods: 320, util: 180, transport: 150, propTax: 15, pit: 0.12, divShare: 0, insurance: 30, leisure: 120, deposits: 0.15 * 5e9, floor: 100 },
  { name: "Engineers", n: 68750, wage: 4800, pension: 0, housing: 1100, food: 850, goods: 750, util: 260, transport: 340, propTax: 45, pit: 0.18, divShare: 0.15, insurance: 60, leisure: 300, deposits: 0.35 * 5e9, floor: 600 },
  { name: "Elite", n: 27500, wage: 6000, pension: 0, housing: 2000, food: 1200, goods: 1800, util: 400, transport: 700, propTax: 180, pit: 0.24, divShare: 0.85, insurance: 180, leisure: 900, deposits: 0.45 * 5e9, floor: 1500 },
  { name: "Retirees & Unemployed", n: 30000, wage: 0, pension: 1000, housing: 300, food: 380, goods: 120, util: 120, transport: 60, propTax: 10, pit: 0, divShare: 0, insurance: 15, leisure: 60, deposits: 0.05 * 5e9, floor: 0 },
];

// Life clock: one game month = one year of life (GDD §56).
const DEMO = {
  retireRate: 1 / 45,      // working households reaching 65 each month
  retireeExit: 1 / 15,     // retirees leaving (death, household merged into heirs)
  naturalEntry: 0.024,     // young households entering the labour market each month
  entrySplit: [0.70, 0.25, 0.05],
  migrationSens: 0.02,     // net migration per month at 100% above/below the floor
  migrationCap: 0.02,
  // Hardship inflows per month for working households (GDD §77)
  jobLoss: 0.006, gambling: 0.0015, idleness: 0.001, lifeCrisis: 0.002, recovery: 0.15,
};

const S = {
  key: 0.07, P: 1, rent: 1, Dh: 5e9, Df: 1.2e9, Lf: 4e9, Lm: 3e9, Bb: 1.5e9, Bcb: 0.3e9,
  refi: 0.5e9, bankCap: 0.9e9, debtRatio: 0.45, inflHist: [0.0025, 0.0025, 0.0025],
  dwellings: 275000 * 1.03, unemployed: 6000, hardship0: 0,
};
const BASE_DWELLING_PRICE = 765 * 12 / 0.08; // average housing payment x 12 / cap rate

type Row = Record<string, number>;
const COLS = ["HH", "Fc", "Fk", "T", "Banks", "CB", "World"] as const;

function step(t: number, log: Row[]) {
  const P = S.P;
  const cycle = 1 + 0.15 * Math.sin((2 * Math.PI * t) / 24); // world commodity cycle (GDD §11)
  const rDep = Math.max(0.005, S.key - 0.03), rFirm = S.key + 0.03, rMort = S.key + 0.01;
  const spread = S.debtRatio < 0.5 ? 0.005 : S.debtRatio < 1.2 ? 0.025 : S.debtRatio < 1.5 ? 0.05 : 0.08;
  const rBond = S.key + spread;

  // ---- households
  const working = classes[0].n + classes[1].n + classes[2].n;
  const hardShare = S.hardship0 === 0 ? 1 : 1; // placeholder, real share tracked below
  const popNow = classes.reduce((a, c) => a + c.n, 0);
  const hardW = [1, 0.5, 0.25, 0]; // how strongly hardship hits each class
  const wages = classes.map((c, i) => c.n * c.wage * P * (1 - S.hardship0 * hardW[i]));
  const benefits = classes.map((c, i) => c.n * c.wage * P * S.hardship0 * hardW[i] * 0.4);
  const W = wages.reduce((a, b) => a + b, 0);
  const pensions = classes.map((c, i) => c.n * c.pension * P + benefits[i]);
  const Dtot = classes.reduce((a, c) => a + Math.max(0, c.deposits), 0);
  const depInt = S.Dh * rDep / 12;
  const housingPay = classes.map(c => c.n * c.housing * P * S.rent);
  const mortInt = S.Lm * rMort / 12;
  const rent = housingPay.reduce((a, b) => a + b, 0) - mortInt;
  const wealthSpend = classes.map(c => Math.max(0, c.deposits) * P0.wealthSpend);
  const cons = classes.map((c, i) => c.n * (c.food + c.goods + c.util + c.transport + c.leisure) * P + wealthSpend[i]);
  const C = cons.reduce((a, b) => a + b, 0);
  const premiums = classes.map(c => c.n * c.insurance * P);
  const PREM = premiums.reduce((a, b) => a + b, 0), CLAIMS = PREM * P0.lossRatio;
  const propTax = classes.map(c => c.n * c.propTax * P);

  // ---- outer world, government, investment (nominal, scale with prices)
  const X = P0.exports * P * cycle, M = P0.imports * P * (C / 548e6);
  const tour = P0.tourism * P, visa = P0.visa * P;
  const popScale = popNow / 275000;
  const G = (P0.govContracts + P0.govPrograms) * P * popScale, subs = P0.subsidies * P * popScale, emin = P0.eminent * P;
  const bankStress = S.bankCap / (S.Lf + S.Lm) < P0.minCapital;
  const capex = P0.capex * P * (bankStress ? 0.5 : 1) * Math.min(1.3, Math.max(0.6, 1 - (rFirm - 0.10) * 4));
  const vacancy = S.dwellings / (classes.reduce((a, c) => a + c.n, 0)) - 1;
  const housingBoost = Math.min(4, Math.max(0.3, 1 + 12 * (0.03 - vacancy)));
  const newHousing = P0.newHousing * P * housingBoost;
  const newMort = bankStress ? 0 : P0.newMortgages * P * housingBoost * (0.08 / rMort);
  const dDf = P0.firmDepChange * P;
  const shadow = P0.shadowShare * P0.evadedDuties * P;

  // ---- firms
  const frev = C + rent + newHousing + G + subs + X + tour + capex + PREM;
  const Wf = W * P0.wageFirms, Wt = W * P0.wagePublic, Wb = W * P0.wageBanks;
  const VAT = P0.vat / (1 + P0.vat) * (C + newHousing);
  const duties = M * P0.importDuty + X * P0.exportDuty + P0.playerDuties * P;
  const lint = S.Lf * rFirm / 12;
  const pre = frev - Wf - M - VAT - duties - lint - shadow - CLAIMS;
  const ctax = Math.max(0, pre) * P0.corpTax, after = pre - ctax;
  const div = Math.max(0, after) * P0.payout, divT = div * P0.stateEquity, divH = div - divT;
  const retained = after - div;
  const dLf = capex - retained + dDf;

  // ---- defaults (GDD §77-78): hardship drives mortgage defaults, rates and slump drive firm defaults
  const hardshipShare = S.hardship0;
  const mortDef = P0.mortDefault * Math.max(0.3, hardshipShare / 0.03) * (rMort / 0.08);
  const firmDef = P0.firmDefault * Math.pow(rFirm / 0.10, 1.5) * Math.max(0.5, 2 - cycle);
  const writeMort = S.Lm * mortDef / 12, writeFirm = S.Lf * firmDef / 12, WO = writeMort + writeFirm;

  // ---- banks and CB
  const bintB = S.Bb * rBond / 12, refiInt = S.refi * S.key / 12;
  const bankGross = lint + mortInt + bintB - depInt - Wb - refiInt;
  const bankDiv = Math.max(0, bankGross - WO);
  const bankLoss = Math.max(0, WO - bankGross);
  const bintCB = S.Bcb * rBond / 12, cbProfit = refiInt + bintCB;

  // ---- treasury
  const PIT = classes.reduce((a, c, i) => a + wages[i] * c.pit, 0);
  const PT = propTax.reduce((a, b) => a + b, 0);
  const PENS = pensions.reduce((a, b) => a + b, 0);
  const trev = PIT + PT + VAT + ctax + duties + visa + divT + cbProfit;
  const texp = Wt + G + PENS + subs + bintB + bintCB + emin;
  const deficit = texp - trev, dB = deficit;

  // ---- household class savings
  const divPool = divH + bankDiv;
  const classSave = classes.map((c, i) => {
    const inc = wages[i] + pensions[i] + divPool * c.divShare + depInt * (Math.max(0, c.deposits) / Dtot);
    const out = wages[i] * c.pit + propTax[i] + housingPay[i] + cons[i] + premiums[i] - CLAIMS * (premiums[i] / PREM);
    return inc - out;
  });
  const extraHH = P0.migrantSavings * P + emin + shadow - newHousing + newMort; // non-class items
  const dDh = classSave.reduce((a, b) => a + b, 0) + extraHH;

  // ---- build the matrix: [label, HH, Fc, Fk, T, Banks, CB, World]
  const m: [string, ...number[]][] = [
    ["Consumption", -C, C, 0, 0, 0, 0, 0],
    ["Rent", -rent, rent, 0, 0, 0, 0, 0],
    ["New housing", -newHousing, newHousing, 0, 0, 0, 0, 0],
    ["Government purchases", 0, G, 0, -G, 0, 0, 0],
    ["Subsidies", 0, subs, 0, -subs, 0, 0, 0],
    ["Investment goods", 0, capex, -capex, 0, 0, 0, 0],
    ["Exports", 0, X, 0, 0, 0, 0, -X],
    ["Tourism", 0, tour, 0, 0, 0, 0, -tour],
    ["Imports", 0, -M, 0, 0, 0, 0, M],
    ["Wages", W, -Wf, 0, -Wt, -Wb, 0, 0],
    ["Pensions", PENS, 0, 0, -PENS, 0, 0, 0],
    ["PIT", -PIT, 0, 0, PIT, 0, 0, 0],
    ["Property tax", -PT, 0, 0, PT, 0, 0, 0],
    ["VAT", 0, -VAT, 0, VAT, 0, 0, 0],
    ["Duties", 0, -duties, 0, duties, 0, 0, 0],
    ["Visa fees", 0, 0, 0, visa, 0, 0, -visa],
    ["Profit tax", 0, -ctax, 0, ctax, 0, 0, 0],
    ["Dividends", divH + bankDiv, -div, 0, divT, -bankDiv, 0, 0],
    ["Deposit interest", depInt, 0, 0, 0, -depInt, 0, 0],
    ["Mortgage interest", -mortInt, 0, 0, 0, mortInt, 0, 0],
    ["Firm loan interest", 0, -lint, 0, 0, lint, 0, 0],
    ["Bond interest", 0, 0, 0, -(bintB + bintCB), bintB, bintCB, 0],
    ["Refinancing interest", 0, 0, 0, 0, -refiInt, refiInt, 0],
    ["CB profit transfer", 0, 0, 0, cbProfit, 0, -cbProfit, 0],
    ["Insurance premiums", -PREM, PREM, 0, 0, 0, 0, 0],
    ["Insurance claims", CLAIMS, -CLAIMS, 0, 0, 0, 0, 0],
    ["Contraband shadow margin", shadow, -shadow, 0, 0, 0, 0, 0],
    ["Retained profits", 0, -retained, retained, 0, 0, 0, 0],
    ["Migrant savings", P0.migrantSavings * P, 0, 0, 0, 0, 0, -P0.migrantSavings * P],
    ["Eminent domain", emin, 0, 0, -emin, 0, 0, 0],
  ];
  const NL = COLS.map((_, j) => m.reduce((a, r) => a + (r[j + 1] as number), 0));
  const bankNL = NL[4];
  const dR = bankNL + dDh + dDf - newMort - dLf - dB;  // bank reserves at the CB (bank plug)
  const fin: [string, ...number[]][] = [
    ["Δ household deposits", -dDh, 0, 0, 0, dDh, 0, 0],
    ["Δ firm deposits", 0, 0, -dDf, 0, dDf, 0, 0],
    ["Δ mortgages", newMort, 0, 0, 0, -newMort, 0, 0],
    ["Δ firm loans", 0, 0, dLf, 0, -dLf, 0, 0],
    ["Δ government bonds", 0, 0, 0, dB, -dB, 0, 0],
    ["Δ bank reserves", 0, 0, 0, 0, -dR, dR, 0],
    ["Δ Outer World account", 0, 0, 0, 0, 0, -(-NL[6]), -NL[6]],
  ];
  const all = [...m, ...fin];
  const rowErr = Math.max(...all.map(r => Math.abs((r.slice(1) as number[]).reduce((a, b) => a + b, 0))));
  const colErr = Math.max(...COLS.map((_, j) => Math.abs(all.reduce((a, r) => a + (r[j + 1] as number), 0))));

  // ---- record
  const pop = classes.reduce((a, c) => a + c.n, 0);
  const moneyGrowth = (dDh + dDf) / (S.Dh + S.Df);
  log.push({
    month: t + 1, cpi: S.P, inflation_annual: S.inflHist[S.inflHist.length - 1] * 12,
    key_rate: S.key, bond_yield: rBond, households: pop,
    workers: classes[0].n, engineers: classes[1].n, elite: classes[2].n, retirees_unemployed: classes[3].n,
    hardship_share: hardshipShare, vacancy, rent_index: S.rent,
    deposits: S.Dh + dDh, money_growth: moneyGrowth, firm_loans: S.Lf + dLf - writeFirm,
    mortgages: S.Lm + newMort - writeMort, write_offs: WO,
    bank_capital_ratio: (S.bankCap - bankLoss) / (S.Lf + dLf + S.Lm + newMort - WO),
    gov_debt: S.Bb + S.Bcb + dB, budget_balance_share: -deficit / trev,
    debt_to_revenue: (S.Bb + S.Bcb + dB) / (trev * 12),
    saving_rate: classSave.reduce((a, b) => a + b, 0) / (W + PENS + divPool + depInt),
    market_cap: div * 12 / (rFirm + 0.04), world_cycle: cycle,
    free_money_workers: (classSave[0] + classes[0].n * classes[0].leisure * P + wealthSpend[0]) / classes[0].n,
    max_row_error: rowErr, max_col_error: colErr,
  });

  // ---- update stocks
  classes.forEach((c, i) => { c.deposits += classSave[i] + extraHH * (Math.max(0, c.deposits) / Dtot); });
  S.Dh += dDh; S.Df += dDf; S.Lf += dLf - writeFirm; S.Lm += newMort - writeMort; S.Bb += dB;
  S.bankCap -= bankLoss;
  S.debtRatio = (S.Bb + S.Bcb) / (trev * 12);
  S.dwellings += newHousing / (BASE_DWELLING_PRICE * P);

  // prices (GDD §76): inflation reacts to money growth above real growth and to world prices
  const realGrowth = (pop - (log.length > 1 ? log[log.length - 2].households : pop)) / pop;
  const infl = 0.0025 + 0.3 * (moneyGrowth - realGrowth - 0.0025) + 0.02 * (cycle - 1) * (M / C);
  S.inflHist.push(infl);
  S.P *= 1 + infl;
  S.rent *= 1 + Math.min(0.02, Math.max(-0.02, 0.5 * (0.03 - vacancy)));
  classes.forEach(c => { c.wage *= 1 + infl; c.pension *= 1 + infl * 0.8; });

  // CB smoothed Taylor rule (GDD §63)
  const ema = S.inflHist.slice(-3).reduce((a, b) => a + b, 0) / 3 * 12;
  const target = Math.min(0.18, Math.max(0.01, 0.07 + 1.5 * (ema - 0.03)));
  S.key += Math.max(-0.015, Math.min(0.015, target - S.key));

  // demography on the life clock + migration + hardship (GDD §56-57, §77)
  const work = classes.slice(0, 3);
  const retiring = work.map(c => c.n * DEMO.retireRate);
  const entrants = working * DEMO.naturalEntry;
  const unemployedRate = classes[3].n > 0 ? S.unemployed / (working + S.unemployed) : 0;
  const inflowHard = working * (DEMO.jobLoss * (1 + 3 * Math.max(0, 1 - cycle)) + DEMO.gambling + DEMO.idleness + DEMO.lifeCrisis);
  const hardPool = (S.hardship0 * working) + inflowHard - (S.hardship0 * working) * DEMO.recovery;
  S.hardship0 = Math.max(0, hardPool / working);
  work.forEach((c, i) => {
    const free = (classSave[i] + c.n * c.leisure * P + wealthSpend[i]) / c.n;
    const gap = c.floor > 0 ? (free - c.floor * P) / (c.floor * P) : 0;
    let mig = Math.max(-DEMO.migrationCap, Math.min(DEMO.migrationCap, DEMO.migrationSens * gap));
    if (mig > 0) mig *= Math.max(0, Math.min(1, vacancy / 0.03)); // migrants need a free dwelling
    c.n += entrants * DEMO.entrySplit[i] - retiring[i] + c.n * mig;
  });
  classes[3].n += retiring.reduce((a, b) => a + b, 0) - classes[3].n * DEMO.retireeExit;
  void unemployedRate; void hardShare;
}

const log: Row[] = [];
for (let t = 0; t < 36; t++) step(t, log);
const keys = Object.keys(log[0]);
const csv = [keys.join(","), ...log.map(r => keys.map(k => r[k]).join(","))].join("\n");
require("fs").writeFileSync("/home/claude/sim/run36.csv", csv);
const worst = Math.max(...log.map(r => Math.max(r.max_row_error, r.max_col_error)));
console.log("max matrix error over 36 months ($):", worst.toFixed(6));
for (const r of log.filter(r => [1, 6, 12, 18, 24, 30, 36].includes(r.month)))
  console.log(r.month, "CPI", r.cpi.toFixed(3), "infl", (r.inflation_annual * 100).toFixed(1) + "%",
    "key", (r.key_rate * 100).toFixed(1) + "%", "hh", Math.round(r.households), "ret", Math.round(r.retirees_unemployed),
    "debt/rev", r.debt_to_revenue.toFixed(2), "bal", (r.budget_balance_share * 100).toFixed(1) + "%",
    "cap", (r.bank_capital_ratio * 100).toFixed(1) + "%", "vac", (r.vacancy * 100).toFixed(1) + "%",
    "rent", r.rent_index.toFixed(2), "save", (r.saving_rate * 100).toFixed(1) + "%", "freeW", r.free_money_workers.toFixed(0),
    "hard", (r.hardship_share * 100).toFixed(1) + "%");
