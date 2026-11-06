import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { money } from "@pentapolis/shared-sim";
import { createPentapolisServer, type RunningPentapolisServer } from "../src/index.ts";

describe("Sprint 4: developers buy materials, timed factory upgrades", () => {
  const dirs: string[] = [];
  let srv: RunningPentapolisServer | null = null;

  afterEach(() => {
    srv?.stop();
    srv = null;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function boot(dbFile?: string): RunningPentapolisServer {
    const file = dbFile ?? join(mkdtempSync(join(tmpdir(), "pentapolis-build-")), "w.sqlite");
    if (!dbFile) dirs.push(join(file, ".."));
    srv = createPentapolisServer({ port: 0, dbPath: file, enableRealtimeLoop: false });
    srv.world.executeCommand({ type: "claim_sector", sectorId: 1, cityName: "Т", mayorName: "М", currency: "UAH" });
    srv.world.engine.getRegion(1).treasuryCashAtCb = money(2_000_000_000);
    return srv;
  }

  const zoneOcc = (s: RunningPentapolisServer) => s.world.getSnapshot().zones[0]!.occupancyRatio;

  test("an isolated zone stays empty; linking the gateway lets developers import and build, paying duty", () => {
    const s = boot();
    const w = s.world;
    expect(w.executeCommand({ type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 300, fromY: 210, toX: 420, toY: 210 }).ok).toBe(true);
    const painted = w.executeCommand({ type: "paint_zone", sectorId: 1, zoneKind: "RES-01", x: 300, y: 212, width: 12, depth: 12 });
    expect(painted.message).toContain("т стройматериалов");
    expect(zoneOcc(s)).toBe(0);

    w.executeCommand({ type: "admin_time_skip", jump: "1d" });
    expect(zoneOcc(s)).toBe(0);
    const stalled = w.getSnapshot().construction.find((c) => c.sectorId === 1)!;
    expect(stalled.gatewayImportOpen).toBe(false);
    expect(stalled.stalledSites).toBe(1);
    expect(w.getSnapshot().zoneSites[0]!.limitingMaterial).not.toBeNull();

    w.executeCommand({ type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 425, fromY: 48, toX: 425, toY: 210 });
    w.executeCommand({ type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 420, fromY: 210, toX: 425, toY: 210 });
    const dwellingsBefore = w.engine.getRegion(1).dwellings;
    const treasuryBefore = w.engine.getRegion(1).treasuryCashAtCb;
    w.executeCommand({ type: "admin_time_skip", jump: "1h" });

    const stats = w.getSnapshot().construction.find((c) => c.sectorId === 1)!;
    expect(stats.gatewayImportOpen).toBe(true);
    expect(zoneOcc(s)).toBeGreaterThan(0);
    // Cottages need only Lumber + Stone (GDD §6.1: no steel, no prefabs)
    const used = stats.materials.filter((m) => m.importedTonsPerHour > 0).map((m) => m.material).sort();
    expect(used).toEqual(["Limestone & Granite", "Lumber"]);
    expect(BigInt(stats.importDutyMinor)).toBeGreaterThan(0n);
    expect(w.engine.getRegion(1).treasuryCashAtCb - treasuryBefore).toBe(BigInt(stats.importDutyMinor));
    expect(w.engine.getRegion(1).dwellings).toBeGreaterThan(dwellingsBefore);
  });

  test("factory upgrades take the sheet-22 game hours and keep producing at the old level meanwhile", () => {
    const dir = mkdtempSync(join(tmpdir(), "pentapolis-upg-"));
    dirs.push(dir);
    const dbFile = join(dir, "w.sqlite");
    const s = boot(dbFile);
    const w = s.world;
    expect(w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "EXT-01", tileX: 300, tileY: 232 }).ok).toBe(true);
    const id = w.getSnapshot().buildings[0]!.id;

    expect(w.executeCommand({ type: "upgrade_building", sectorId: 1, buildingId: id }).ok).toBe(false); // still under construction
    for (let d = 0; d < 2; d++) w.executeCommand({ type: "admin_time_skip", jump: "1d" });

    const started = w.executeCommand({ type: "upgrade_building", sectorId: 1, buildingId: id });
    expect(started.ok, started.message).toBe(true);
    expect(started.message).toContain("24 игровых ч");
    let b = w.getSnapshot().buildings[0]!;
    expect(b.level).toBe(1);
    expect(b.upgradeTargetLevel).toBe(2);
    expect(w.executeCommand({ type: "upgrade_building", sectorId: 1, buildingId: id }).ok).toBe(false);

    for (let h = 0; h < 12; h++) w.executeCommand({ type: "admin_time_skip", jump: "1h" });
    s.stop();
    srv = null;
    const s2 = createPentapolisServer({ port: 0, dbPath: dbFile, enableRealtimeLoop: false });
    srv = s2;
    b = s2.world.getSnapshot().buildings[0]!;
    expect(b.upgradeTargetLevel).toBe(2);
    expect(b.upgradeProgress).toBeCloseTo(0.5, 1);

    s2.world.executeCommand({ type: "admin_time_skip", jump: "1d" });
    b = s2.world.getSnapshot().buildings[0]!;
    expect(b.level).toBe(2);
    expect(b.upgradeTargetLevel).toBeNull();
  });
});
