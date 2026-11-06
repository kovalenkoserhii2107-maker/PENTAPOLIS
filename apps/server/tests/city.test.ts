import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { money } from "@pentapolis/shared-sim";
import { createPentapolisServer, type RunningPentapolisServer } from "../src/index.ts";

/** Sector 1 district on clean land, linked to the Northern Highway gateway (see traffic.test.ts). */
describe("Sprint 6: city services, emergencies with dispatch, land value, car lifecycle, advisors", () => {
  const dirs: string[] = [];
  let srv: RunningPentapolisServer | null = null;

  afterEach(() => {
    srv?.stop();
    srv = null;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function boot(): RunningPentapolisServer {
    const dir = mkdtempSync(join(tmpdir(), "pentapolis-city-"));
    dirs.push(dir);
    srv = createPentapolisServer({
      port: 0,
      dbPath: join(dir, "w.sqlite"),
      worldId: "pentapolis-city-test-v1",
      enableRealtimeLoop: false,
    });
    const w = srv.world;
    w.executeCommand({ type: "claim_sector", sectorId: 1, cityName: "Т", mayorName: "М", currency: "UAH" });
    w.engine.getRegion(1).treasuryCashAtCb = money(2_000_000_000);
    const cmds = [
      { type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 300, fromY: 210, toX: 420, toY: 210 },
      { type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 425, fromY: 48, toX: 425, toY: 210 },
      { type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 420, fromY: 210, toX: 425, toY: 210 },
      { type: "paint_zone", sectorId: 1, zoneKind: "RES-02", x: 300, y: 212, width: 12, depth: 12 },
      { type: "place_building", sectorId: 1, catalogId: "EXT-01", tileX: 380, tileY: 212 },
    ] as const;
    for (const c of cmds) expect(w.executeCommand(c).ok).toBe(true);
    for (let d = 0; d < 3; d++) w.executeCommand({ type: "admin_time_skip", jump: "1d" });
    return srv;
  }

  const mine = (s: RunningPentapolisServer) => s.world.getSnapshot().buildings.find((b) => b.catalogId === "EXT-01")!;

  test("an unattended fire burns a level off the mine; a fire station dispatches an engine with a real crew", async () => {
    const s = boot();
    const w = s.world;
    expect(w.executeCommand({ type: "upgrade_building", sectorId: 1, buildingId: mine(s).id }).ok).toBe(true);
    w.executeCommand({ type: "admin_time_skip", jump: "1d" });
    expect(mine(s).level).toBe(2);

    const fire = w.executeCommand({ type: "admin_trigger_emergency", sectorId: 1, emergencyId: "FIRE" });
    expect(fire.message).toContain("нет службы SAF-02");
    const emg = w.getSnapshot().emergencies.find((e) => e.emergencyId === "FIRE")!;
    expect(emg.attended).toBe(false);
    expect(emg.statusRu).toContain("втрое");
    for (let h = 0; h < 5; h++) w.executeCommand({ type: "admin_time_skip", jump: "1h" });
    expect(mine(s).level).toBe(1);
    expect(w.getSnapshot().recentChat.some((m) => m.text.includes("потерял уровень"))).toBe(true);

    expect(w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "SAF-02", tileX: 330, tileY: 203 }).ok).toBe(true);
    w.executeCommand({ type: "admin_time_skip", jump: "1d" });
    const second = w.executeCommand({ type: "admin_trigger_emergency", sectorId: 1, emergencyId: "FIRE" });
    expect(second.message).toContain("выехала бригада");
    const attended = w.getSnapshot().emergencies.find((e) => e.emergencyId === "FIRE")!;
    expect(attended.attended).toBe(true);
    expect(attended.responders![0]!.vehicleTypeId).toBe("MUN-04");

    const engine = w.getTrafficState().vehicles.find((v) => v.role === "emergency")!;
    expect(engine.vehicleTypeId).toBe("MUN-04");
    const card = (await (await fetch(`${s.url}/api/vehicle/${engine.id}`)).json()) as { destinationLabel: string; driverCitizenId: string };
    expect(card.destinationLabel).toContain("Выезд на ЧП");
    const dossier = (await (await fetch(`${s.url}/api/citizen/${card.driverCitizenId}`)).json()) as {
      workplace: { roleRu: string };
      car?: { stage: number; wearPercent: number; historyRu: string } | null;
    };
    expect(dossier.workplace.roleRu).toBe("Пожарный");
    if (dossier.car) {
      expect(dossier.car.stage).toBeGreaterThanOrEqual(1);
      expect(dossier.car.stage).toBeLessThanOrEqual(5);
      expect(dossier.car.historyRu.length).toBeGreaterThan(3);
    }

    // Clear roads (V/C <= 1.2) resolve emergency early within 3 game hours
    for (let h = 0; h < 3; h++) w.executeCommand({ type: "admin_time_skip", jump: "1h" });
    expect(w.getSnapshot().emergencies.some((e) => e.emergencyId === "FIRE")).toBe(false);
    expect(w.getTrafficState().vehicles.some((v) => v.role === "emergency")).toBe(false);
  });

  test("services raise land value (0..100, P/M/R) and fill the advisor and car-fleet panels", () => {
    const s = boot();
    const w = s.world;
    const before = w.getSnapshot();
    const homesBefore = before.districts.find((d) => d.zoneKind === "RES-02")!;
    const zoneBefore = before.zones.find((z) => z.zoneKind === "RES-02")!;
    expect(homesBefore.coverage.police).toBe(0);
    expect(zoneBefore.landValue).toBeDefined();
    expect(["P", "M", "R"]).toContain(zoneBefore.districtClass!);
    expect(before.advisors.find((a) => a.sectorId === 1)!.advisors[0]!.tips[0]!.severity).toBe("critical");

    for (const [catalogId, x] of [["SAF-02", 304], ["SAF-01", 312], ["HLT-01", 318], ["CIV-03", 324]] as const) {
      expect(w.executeCommand({ type: "place_building", sectorId: 1, catalogId, tileX: x, tileY: 203 }).ok).toBe(true);
    }
    w.executeCommand({ type: "admin_time_skip", jump: "1d" });
    const after = w.getSnapshot();
    const homes = after.districts.find((d) => d.zoneKind === "RES-02")!;
    const zoneAfter = after.zones.find((z) => z.zoneKind === "RES-02")!;
    expect(homes.coverage.police).toBe(1);
    expect(homes.landValuePerTile).toBeGreaterThan(homesBefore.landValuePerTile);
    expect(zoneAfter.landValue!).toBeGreaterThan(zoneBefore.landValue!);
    expect(homes.crimeRate).toBeLessThan(homesBefore.crimeRate);
    expect(after.city.find((c) => c.sectorId === 1)!.coverage.fire).toBe(1);
    expect(after.autos.find((a) => a.sectorId === 1)!.fleetByStage.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  test("upgrade_zone and Eminent Domain demolish_zone book double-entry BigInt rows with 0n discrepancy", () => {
    const s = boot();
    const w = s.world;
    const snap0 = w.getSnapshot();
    const z0 = snap0.zones.find((z) => z.zoneKind === "RES-02")!;
    expect(z0.occupancyRatio).toBeGreaterThan(0);

    // Upgrade RES-02 -> RES-03: developers must buy Prefabs + Steel and book Fk -> World
    const up = w.executeCommand({ type: "upgrade_zone", sectorId: 1, zoneId: z0.id });
    expect(up.ok).toBe(true);
    expect(w.getSnapshot().zones.find((z) => z.id === z0.id)!.zoneKind).toBe("RES-03");
    w.executeCommand({ type: "admin_time_skip", jump: "1d" });

    // Insufficient treasury must block Eminent Domain demolition
    const reg = w.engine.getRegion(1);
    reg.treasuryCashAtCb = money(100);
    const blocked = w.executeCommand({ type: "demolish_zone", sectorId: 1, zoneId: z0.id });
    expect(blocked.ok).toBe(false);

    // Sufficient treasury pays 100% market buyout (T -> HH) and closes monthly matrix at 0n
    reg.treasuryCashAtCb = money(500_000_000);
    const cashBefore = reg.treasuryCashAtCb;
    const demolished = w.executeCommand({ type: "demolish_zone", sectorId: 1, zoneId: z0.id });
    expect(demolished.ok).toBe(true);
    expect(reg.treasuryCashAtCb).toBeLessThan(cashBefore);
    expect(w.getSnapshot().zones.some((z) => z.id === z0.id)).toBe(false);

    w.executeCommand({ type: "admin_time_skip", jump: "1mo" });
    const snapAfterMonth = w.getSnapshot();
    expect(snapAfterMonth.invariantAllZero).toBe(true);
    const s1 = snapAfterMonth.sectors.find((sec) => sec.sectorId === 1)!;
    expect(s1.maxErrorMinor).toBe("0");
    expect(s1.lastMatrix.some((r) => r.label === "Eminent domain buyout (demolition)")).toBe(true);
  });
});
