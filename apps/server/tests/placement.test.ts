import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { money } from "@pentapolis/shared-sim";
import { createPentapolisServer, type RunningPentapolisServer } from "../src/index.ts";

describe("Placement rules: buildings, zones and roads never overlap", () => {
  const dirs: string[] = [];
  let srv: RunningPentapolisServer | null = null;

  afterEach(() => {
    srv?.stop();
    srv = null;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function boot() {
    const dir = mkdtempSync(join(tmpdir(), "pentapolis-place-"));
    dirs.push(dir);
    srv = createPentapolisServer({ port: 0, dbPath: join(dir, "w.sqlite"), enableRealtimeLoop: false, enforceStageUnlocks: false });
    const w = srv.world;
    w.executeCommand({ type: "claim_sector", sectorId: 1, cityName: "Т", mayorName: "М", currency: "UAH" });
    w.engine.getRegion(1).treasuryCashAtCb = money(2_000_000_000);
    expect(w.executeCommand({ type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 300, fromY: 210, toX: 420, toY: 210 }).ok).toBe(true);
    return w;
  }

  test("a zone cannot cover a road, another zone or a building", () => {
    const w = boot();
    const onRoad = w.executeCommand({ type: "paint_zone", sectorId: 1, zoneKind: "RES-01", x: 320, y: 205, width: 10, depth: 10 });
    expect(onRoad.ok).toBe(false);
    expect(onRoad.message).toContain("улица");

    expect(w.executeCommand({ type: "paint_zone", sectorId: 1, zoneKind: "RES-01", x: 320, y: 212, width: 10, depth: 10 }).ok).toBe(true);
    const twice = w.executeCommand({ type: "paint_zone", sectorId: 1, zoneKind: "COM-01", x: 325, y: 215, width: 10, depth: 10 });
    expect(twice.ok).toBe(false);
    expect(twice.message).toContain("RES-01");

    expect(w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "UTL-01", tileX: 350, tileY: 214 }).ok).toBe(true);
    const onBuilding = w.executeCommand({ type: "paint_zone", sectorId: 1, zoneKind: "RES-01", x: 348, y: 212, width: 8, depth: 8 });
    expect(onBuilding.ok).toBe(false);
    expect(w.getSnapshot().zones.length).toBe(1);
  });

  test("a building cannot sit on a zone or a road; a bus stop may stand at the kerb", () => {
    const w = boot();
    expect(w.executeCommand({ type: "paint_zone", sectorId: 1, zoneKind: "RES-01", x: 320, y: 212, width: 10, depth: 10 }).ok).toBe(true);
    expect(w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "UTL-01", tileX: 322, tileY: 214 }).ok).toBe(false);
    expect(w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "UTL-01", tileX: 360, tileY: 207 }).ok).toBe(false);
    expect(w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "TRN-01", tileX: 324, tileY: 211 }).ok).toBe(true);
  });

  test("a road cannot run through a building or across a zone", () => {
    const w = boot();
    expect(w.executeCommand({ type: "paint_zone", sectorId: 1, zoneKind: "RES-01", x: 320, y: 212, width: 10, depth: 10 }).ok).toBe(true);
    expect(w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "UTL-01", tileX: 360, tileY: 214 }).ok).toBe(true);
    const throughZone = w.executeCommand({ type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 325, fromY: 210, toX: 325, toY: 240 });
    expect(throughZone.ok).toBe(false);
    expect(throughZone.message).toContain("RES-01");
    const throughBuilding = w.executeCommand({ type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 362, fromY: 210, toX: 362, toY: 240 });
    expect(throughBuilding.ok).toBe(false);
    // Along the zone's edge is fine
    expect(w.executeCommand({ type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 318, fromY: 210, toX: 318, toY: 240 }).ok).toBe(true);
    // Pipelines and power lines pass over blocks
    expect(w.executeCommand({ type: "build_segment", sectorId: 1, kind: "hv_power", fromX: 325, fromY: 230, toX: 325, toY: 240 }).ok).toBe(true);
  });
});

describe("Development stages follow the city actually built (GDD §6.1)", () => {
  const dirs: string[] = [];
  let srv: RunningPentapolisServer | null = null;

  afterEach(() => {
    srv?.stop();
    srv = null;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("a new sector starts at S0: S1+ buildings, networks and zones and megaprojects stay locked", () => {
    const dir = mkdtempSync(join(tmpdir(), "pentapolis-stage-"));
    dirs.push(dir);
    srv = createPentapolisServer({ port: 0, dbPath: join(dir, "w.sqlite"), enableRealtimeLoop: false });
    const w = srv.world;
    w.executeCommand({ type: "claim_sector", sectorId: 1, cityName: "Т", mayorName: "М", currency: "UAH" });
    w.engine.getRegion(1).treasuryCashAtCb = money(2_000_000_000);

    const sec = w.getSnapshot().sectors.find((s) => s.sectorId === 1)!;
    expect(sec.stage).toBe("S0");
    expect(sec.cityHouseholds).toBe(0);
    expect(sec.nextStage).toMatchObject({ stage: "S1", minHouseholds: 1000 });

    // S0 items work
    expect(w.executeCommand({ type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 300, fromY: 210, toX: 420, toY: 210 }).ok).toBe(true);
    expect(w.executeCommand({ type: "paint_zone", sectorId: 1, zoneKind: "RES-01", x: 320, y: 212, width: 10, depth: 10 }).ok).toBe(true);

    // S1+ items explain what they wait for
    const mill = w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "PRO-01", tileX: 360, tileY: 230 });
    expect(mill.ok).toBe(false);
    expect(mill.message).toContain("S1");
    expect(mill.message).toMatch(/1\s000/);
    expect(w.executeCommand({ type: "build_segment", sectorId: 1, kind: "avenue_4lane", fromX: 300, fromY: 250, toX: 420, toY: 250 }).ok).toBe(false);
    expect(w.executeCommand({ type: "paint_zone", sectorId: 1, zoneKind: "RES-03", x: 340, y: 212, width: 10, depth: 10 }).ok).toBe(false);
    const mega = w.executeCommand({ type: "found_megaproject", sectorId: 1, catalogId: "MEG-02" });
    expect(mega.ok).toBe(false);
    expect(mega.message).toContain("S4");
  });
});
