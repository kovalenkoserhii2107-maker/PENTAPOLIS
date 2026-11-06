import { describe, expect, test } from "bun:test";
import { RegionalMoneyEngine, money } from "../src/index.ts";

describe("City flows booked into the 7-column ledger", () => {
  test("a booked treasury payment settles from treasury cash, not new debt, and keeps every invariant at 0", () => {
    const base = new RegionalMoneyEngine({ mode: "mature" });
    const booked = new RegionalMoneyEngine({ mode: "mature" });
    for (const e of [base, booked]) e.stepMonth();

    const comp = money(2_500_000);
    // The server pays the compensation from the treasury at once...
    booked.getRegion(1).treasuryCashAtCb -= comp;
    base.getRegion(1).treasuryCashAtCb -= comp;
    // ...and books it so the macro economy sees households receiving it
    booked.bookEminentDomainBuyout(1, comp, "HH");

    const cashBefore = booked.getRegion(1).treasuryCashAtCb;
    const [repBase] = base.stepMonth();
    const [repBooked] = booked.stepMonth();
    expect(repBooked!.invariants.valid).toBe(true);
    expect(repBooked!.invariants.maxRowError).toBe(0n);
    expect(repBooked!.invariants.maxColError).toBe(0n);

    // No second payment: the engine does not move the cash again
    expect(booked.getRegion(1).treasuryCashAtCb).toBe(cashBefore);
    // No double financing: the same amount of government bonds is issued with or without the booking
    const bonds = (e: RegionalMoneyEngine) => e.getRegion(1).govBondsBanks + e.getRegion(1).govBondsCb;
    expect(bonds(booked)).toBe(bonds(base));
    expect(repBase!.invariants.valid).toBe(true);
  });

  test("rows that do not sum to zero or touch the CB column are rejected", () => {
    const e = new RegionalMoneyEngine({ mode: "mature" });
    expect(() => e.bookLedgerEntry(1, ["bad", 1n, 0n, 0n, 0n, 0n, 0n, 0n])).toThrow();
    expect(() => e.bookLedgerEntry(1, ["cb", 1n, 0n, 0n, 0n, 0n, -1n, 0n])).toThrow();
  });
});
