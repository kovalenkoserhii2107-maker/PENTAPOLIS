import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { epidemicContagionMultiplier, money } from "@pentapolis/shared-sim";
import { createPentapolisServer, type RunningPentapolisServer } from "../src/index.ts";

/**
 * S1 | S2 border runs north-south at x = 489 | 490 around y = 200..240.
 *   S1: iron mine (445,209) on a street y=207 ending at the border post (486,204).
 *   S2: steel mill (505,209) on a street y=207 starting just east of the post.
 */
describe("Sprint 7: border posts, cross-border trade, megaprojects, exchange, AI governor", () => {
  const dirs: string[] = [];
  let srv: RunningPentapolisServer | null = null;

  afterEach(() => {
    srv?.stop();
    srv = null;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function boot(): RunningPentapolisServer {
    const dir = mkdtempSync(join(tmpdir(), "pentapolis-geo-"));
    dirs.push(dir);
    srv = createPentapolisServer({ port: 0, dbPath: join(dir, "w.sqlite"), enableRealtimeLoop: false });
    const w = srv.world;
    w.executeCommand({ type: "claim_sector", sectorId: 1, cityName: "Запад", mayorName: "А", currency: "UAH" });
    w.executeCommand({ type: "claim_sector", sectorId: 2, cityName: "Восток", mayorName: "Б", currency: "PLN" });
    for (const s of [1, 2] as const) w.engine.getRegion(s).treasuryCashAtCb = money(2_000_000_000);
    return srv;
  }

  function buildCorridor(s: RunningPentapolisServer) {
    const w = s.world;
    const cmds = [
      { type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 440, fromY: 207, toX: 488, toY: 207 },
      { type: "build_segment", sectorId: 2, kind: "street_2lane", fromX: 491, fromY: 207, toX: 540, toY: 207 },
      { type: "place_building", sectorId: 1, catalogId: "EXT-01", tileX: 445, tileY: 209 },
      { type: "place_building", sectorId: 2, catalogId: "PRO-01", tileX: 505, tileY: 209, cityShareOverride: 0.1 },
      { type: "place_building", sectorId: 1, catalogId: "LOG-07", tileX: 486, tileY: 200 },
    ] as const;
    for (const c of cmds) {
      const out = w.executeCommand(c);
      expect(out.ok, out.message).toBe(true);
    }
    for (let d = 0; d < 3; d++) w.executeCommand({ type: "admin_time_skip", jump: "1d" });
  }

  const postId = (s: RunningPentapolisServer) => s.world.getSnapshot().borderPosts[0]!.id;

  test("a border post links both road networks; ore crosses to the neighbour's mill and pays duty", async () => {
    const s = boot();
    const w = s.world;
    const inside = w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "LOG-07", tileX: 440, tileY: 220 });
    expect(inside.ok).toBe(false);
    expect(inside.message).toContain("границы");

    buildCorridor(s);
    const snap = w.getSnapshot();
    expect(snap.borderPosts[0]).toMatchObject({ sectorA: 1, sectorB: 2 });
    const stats = snap.borderStats[0]!;
    expect(stats.roadLinked).toBe(true);
    expect(stats.trucksPerHour).toBeGreaterThan(0);
    expect(stats.flows[0]).toMatchObject({ fromSector: 1, toSector: 2, lane: "raw", commodity: "Iron Ore" });
    const s2 = stats.revenue.find((r) => r.sectorId === 2)!;
    const s1 = stats.revenue.find((r) => r.sectorId === 1)!;
    expect(BigInt(s2.dutyMinor)).toBeGreaterThan(0n); // 5% raw import duty
    expect(BigInt(s1.dutyMinor)).toBeGreaterThan(0n); // 2% raw export duty

    const truck = w.getTrafficState().vehicles.find((v) => v.role === "freight")!;
    const card = (await (await fetch(`${s.url}/api/vehicle/${truck.id}`)).json()) as { destinationLabel: string; cargo: { dutyLabel: string } };
    expect(card.destinationLabel).toContain("через КПП");
    expect(card.cargo.dutyLabel).toContain("Ввозная пошлина 5.0%");

    // S2 embargoes raw materials: the notice window delays it, then the flow stops
    const embargo = w.executeCommand({ type: "set_border_policy", sectorId: 2, postId: postId(s), embargo: ["raw"] });
    expect(embargo.message).toContain("через 6");
    expect(w.getSnapshot().borderPosts[0]!.pending.length).toBe(1);
    expect(w.getSnapshot().recentChat.some((m) => m.text.includes("ОКНО УВЕДОМЛЕНИЯ для Сектора 1"))).toBe(true);
    w.executeCommand({ type: "admin_time_skip", jump: "1d" });
    expect(w.getSnapshot().borderStats[0]!.trucksPerHour).toBeGreaterThan(0);
    for (let d = 0; d < 6; d++) w.executeCommand({ type: "admin_time_skip", jump: "1d" });
    expect(w.getSnapshot().borderPosts[0]!.pending.length).toBe(0);
    expect(w.getSnapshot().borderStats[0]!.trucksPerHour).toBe(0);

    // A friendly duty cut applies at once
    const cut = w.executeCommand({ type: "set_border_policy", sectorId: 2, postId: postId(s), importDuty: { manufactured: 0.02 } });
    expect(cut.message).toContain("обновлён");
  });

  test("megaprojects are funded from the SWF, built, and pay dividends without breaking the ledger", () => {
    const s = boot();
    const w = s.world;
    const placed = w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "MEG-02", tileX: 470, tileY: 470 });
    expect(placed.ok, placed.message).toBe(true);
    const meg = w.getSnapshot().megaprojects[0]!;
    expect(meg.status).toBe("funding");
    const cost = BigInt(meg.costWcuMinor);

    w.engine.getRegion(1).swfBalanceWcu = cost;
    w.engine.getRegion(2).swfBalanceWcu = cost;
    expect(w.executeCommand({ type: "contribute_megaproject", sectorId: 1, buildingId: meg.buildingId, amountUnits: Number(cost / 100n) * 0.6, source: "swf" }).ok).toBe(true);
    const second = w.executeCommand({ type: "contribute_megaproject", sectorId: 2, buildingId: meg.buildingId, amountUnits: Number(cost / 100n), source: "swf" });
    expect(second.ok).toBe(true);
    const funded = w.getSnapshot().megaprojects[0]!;
    expect(funded.status).toBe("building");
    expect(funded.stakes.find((st) => st.sectorId === 1)!.share).toBeCloseTo(0.6);
    expect(funded.fundedWcuMinor).toBe(meg.costWcuMinor); // capped at cost

    // Catalog build time: 2,160 game hours (3 game months)
    for (let m = 0; m < 4; m++) w.executeCommand({ type: "admin_time_skip", jump: "1mo" });
    const done = w.getSnapshot();
    expect(done.megaprojects[0]!.status).toBe("operational");
    expect(done.powerRing.find((r) => r.sectorId === 1)!.supplyMw).toBeGreaterThan(1500);
    expect(done.invariantAllZero).toBe(true);
    expect(done.sectors.find((x) => x.sectorId === 1)!.hegemony).toBeDefined();
  });

  test("a neighbour buys a stake with SWF money; foreign shareholders block demolition; the AI governor takes over", () => {
    const s = boot();
    const w = s.world;
    buildCorridor(s);
    expect(w.executeCommand({ type: "place_building", sectorId: 2, catalogId: "FIN-02", tileX: 510, tileY: 195 }).ok).toBe(true);
    for (let d = 0; d < 5; d++) w.executeCommand({ type: "admin_time_skip", jump: "1d" });
    const mill = w.getSnapshot().exchange.find((c) => c.sectorId === 2 && c.nameRu.includes("Сталелитейный"))!;
    expect(mill).toBeDefined();
    expect(mill.privateShare).toBeCloseTo(0.9);

    w.engine.getRegion(1).swfBalanceWcu = money(500_000_000);
    const buy = w.executeCommand({ type: "trade_stake", sectorId: 1, buildingId: mill.buildingId, deltaShare: 0.2, source: "swf" });
    expect(buy.ok, buy.message).toBe(true);
    expect(w.getSnapshot().exchange.find((c) => c.buildingId === mill.buildingId)!.foreignStakes).toEqual([{ sectorId: 1, share: 0.2 }]);
    expect(w.engine.getRegion(1).swfBalanceWcu).toBeLessThan(money(500_000_000));

    const privatise = w.executeCommand({ type: "trade_stake", sectorId: 2, buildingId: mill.buildingId, deltaShare: 0.15, source: "treasury" });
    expect(privatise.ok, privatise.message).toBe(true);
    const demolish = w.executeCommand({ type: "bulldoze_building", sectorId: 2, buildingId: mill.buildingId });
    expect(demolish.ok).toBe(false);

    w.engine.getRegion(1).lastMayorActivityEpochMs = 0;
    w.executeCommand({ type: "admin_time_skip", jump: "1d" });
    expect(w.engine.getRegion(1).isAiGovernor).toBe(true);
    expect(w.getSnapshot().recentChat.some((m) => m.text.includes("ИИ-Губернатор"))).toBe(true);
  });

  test("sanitary quarantine blocks passenger crossers immediately while keeping freight running and cuts epidemic contagion by 90%", () => {
    const s = boot();
    const w = s.world;
    buildCorridor(s);
    const before = w.getSnapshot().borderStats[0]!;
    expect(before.crossersPerMonth).toBeGreaterThan(0);
    expect(before.trucksPerHour).toBeGreaterThan(0);

    const q = w.executeCommand({
      type: "set_border_policy",
      sectorId: 2,
      postId: postId(s),
      sanitaryQuarantine: true,
    });
    expect(q.ok, q.message).toBe(true);

    const after = w.getSnapshot().borderStats[0]!;
    expect(after.crossersPerMonth).toBe(0);
    expect(after.trucksPerHour).toBeGreaterThan(0);
    expect(epidemicContagionMultiplier(false)).toBe(1);
    expect(epidemicContagionMultiplier(true)).toBeCloseTo(0.1);
  });

  test("trunk gas pipeline boosts neighbour steel +40% and powers ENG-02; emergency gas valve shutoff immediately drops boost and forces 45% fuel-oil mode", () => {
    const s = boot();
    const w = s.world;
    buildCorridor(s);

    // Build gas well EXT-07 in S1, trunk pipelines across KPP, and gas turbine ENG-02 in S2
    const cmds = [
      { type: "build_segment", sectorId: 1, kind: "pipeline", fromX: 415, fromY: 206, toX: 488, toY: 206 },
      { type: "build_segment", sectorId: 2, kind: "pipeline", fromX: 491, fromY: 206, toX: 545, toY: 206 },
      { type: "place_building", sectorId: 1, catalogId: "EXT-07", tileX: 415, tileY: 198 },
      { type: "place_building", sectorId: 2, catalogId: "ENG-02", tileX: 530, tileY: 198 },
    ] as const;
    for (const c of cmds) {
      const out = w.executeCommand(c);
      expect(out.ok, out.message).toBe(true);
    }
    for (let d = 0; d < 4; d++) w.executeCommand({ type: "admin_time_skip", jump: "1d" });

    const openSnap = w.getSnapshot();
    const s2GasOpen = openSnap.gas.find((g) => g.sectorId === 2)!;
    expect(s2GasOpen.gasifiedPlants).toBeGreaterThan(0);
    expect(s2GasOpen.avgOutputBoost).toBeCloseTo(0.4, 2);
    expect(s2GasOpen.backupFuelOilBurned ?? false).toBe(false);
    const mwOpen = openSnap.sectors.find((sec) => sec.sectorId === 2)!.powerSupplyMw;
    expect(mwOpen).toBeGreaterThan(100);

    // Emergency gas valve shutoff by S1
    const shut = w.executeCommand({
      type: "set_gas_valve",
      sectorId: 1,
      postId: postId(s),
      open: false,
    });
    expect(shut.ok, shut.message).toBe(true);

    const closedSnap = w.getSnapshot();
    const s2GasClosed = closedSnap.gas.find((g) => g.sectorId === 2)!;
    expect(s2GasClosed.gasifiedPlants).toBe(0);
    expect(s2GasClosed.avgOutputBoost).toBe(0);
    expect(s2GasClosed.backupFuelOilBurned).toBe(true);
    const mwClosed = closedSnap.sectors.find((sec) => sec.sectorId === 2)!.powerSupplyMw;
    expect(mwClosed - 35).toBeCloseTo((mwOpen - 35) * 0.45, 0);

    // Advance 1 month to verify emergency fuel oil & cross-border clearing preserve double-entry 0n
    w.executeCommand({ type: "admin_time_skip", jump: "1mo" });
    expect(w.getSnapshot().invariantAllZero).toBe(true);
  });

  test("hostile cross-sector bid > 25% opens 4-day Notice Window and allows home Mayor right-of-first-refusal buyout", () => {
    const s = boot();
    const w = s.world;
    buildCorridor(s);
    expect(w.executeCommand({ type: "place_building", sectorId: 2, catalogId: "FIN-02", tileX: 510, tileY: 195 }).ok).toBe(true);
    for (let d = 0; d < 5; d++) w.executeCommand({ type: "admin_time_skip", jump: "1d" });

    const mill = w.getSnapshot().exchange.find((c) => c.sectorId === 2 && c.nameRu.includes("Сталелитейный"))!;
    expect(mill).toBeDefined();

    const s1SwfBefore = money(800_000_000);
    w.engine.getRegion(1).swfBalanceWcu = s1SwfBefore;

    // S1 bids 30% (> 25% hostile takeover threshold) -> enters 4-day Notice Window
    const bid = w.executeCommand({
      type: "trade_stake",
      sectorId: 1,
      buildingId: mill.buildingId,
      deltaShare: 0.3,
      source: "swf",
    });
    expect(bid.ok, bid.message).toBe(true);

    const snapPending = w.getSnapshot();
    expect(snapPending.pendingTakeovers?.length).toBe(1);
    const tk = snapPending.pendingTakeovers![0]!;
    expect(tk.bidderSectorId).toBe(1);
    expect(tk.targetSectorId).toBe(2);
    expect(w.engine.getRegion(1).swfBalanceWcu).toBeLessThan(s1SwfBefore);

    // Home Mayor (S2) exercises right-of-first-refusal (`preempt_takeover`) from treasury
    const preempt = w.executeCommand({
      type: "preempt_takeover",
      sectorId: 2,
      takeoverId: tk.id,
      source: "treasury",
    });
    expect(preempt.ok, preempt.message).toBe(true);
    expect(w.getSnapshot().pendingTakeovers?.length ?? 0).toBe(0);
    // Bidder SWF escrow refunded in full
    expect(w.engine.getRegion(1).swfBalanceWcu).toBe(s1SwfBefore);
    // Home city share increased from 10% to 40%
    const updatedMill = w.getSnapshot().exchange.find((c) => c.buildingId === mill.buildingId)!;
    expect(updatedMill.cityShare).toBeCloseTo(0.4);

    w.executeCommand({ type: "admin_time_skip", jump: "1mo" });
    expect(w.getSnapshot().invariantAllZero).toBe(true);
  });

  test("MEG-04 International Techno-Collider can be founded in Central Core, receives Steel caravans + WCU tranches, and closes ledger at 0n", () => {
    const s = boot();
    const w = s.world;

    const founded = w.executeCommand({
      type: "found_megaproject",
      sectorId: 1,
      catalogId: "MEG-04",
    });
    expect(founded.ok, founded.message).toBe(true);

    const meg = w.getSnapshot().megaprojects.find((m) => m.catalogId === "MEG-04")!;
    expect(meg).toBeDefined();
    expect(meg.status).toBe("funding");

    // Send a 5,000-ton Steel caravan from S1 treasury
    const caravan = w.executeCommand({
      type: "contribute_megaproject",
      sectorId: 1,
      buildingId: meg.buildingId,
      amountUnits: 0,
      source: "treasury",
      caravanCommodity: "Steel",
      caravanTons: 5000,
    });
    expect(caravan.ok, caravan.message).toBe(true);
    const afterCaravan = w.getSnapshot().megaprojects.find((m) => m.catalogId === "MEG-04")!;
    expect(afterCaravan.deliveredResources?.Steel).toBe(5000);
    expect(BigInt(afterCaravan.fundedWcuMinor)).toBeGreaterThan(0n);

    // Complete remaining WCU from S2 SWF
    const totalCost = BigInt(meg.costWcuMinor);
    w.engine.getRegion(2).swfBalanceWcu = totalCost;
    const finish = w.executeCommand({
      type: "contribute_megaproject",
      sectorId: 2,
      buildingId: meg.buildingId,
      amountUnits: Number(totalCost / 100n),
      source: "swf",
    });
    expect(finish.ok, finish.message).toBe(true);
    expect(w.getSnapshot().megaprojects.find((m) => m.catalogId === "MEG-04")!.status).toBe("building");

    for (let m = 0; m < 4; m++) w.executeCommand({ type: "admin_time_skip", jump: "1mo" });
    const done = w.getSnapshot();
    expect(done.megaprojects.find((m) => m.catalogId === "MEG-04")!.status).toBe("operational");
    expect(done.invariantAllZero).toBe(true);
  });
});
