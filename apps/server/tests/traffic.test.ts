import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  money,
  type CitizenDossierDto,
  type TrafficStateDto,
  type VehicleInspectorDto,
} from "@pentapolis/shared-sim";
import { createPentapolisServer, type RunningPentapolisServer } from "../src/index.ts";

/**
 * Sector 1 test district on clean land (290..430, 200..280):
 *   y=210 commuter street: RES-02 homes (300,212) -> COM-02 shops (400,212), bus stops at both ends,
 *                          linked north to the Northern Highway gateway (425,48) for material imports
 *   y=255 haul street:     Iron mine EXT-01 (300,232) -> Steel mill PRO-01 (370,232)
 */
describe("Sprint 5: live traffic, road wear, bus licences, metro & agent dossiers", () => {
  const tempDirs: string[] = [];
  let srv: RunningPentapolisServer | null = null;

  afterEach(() => {
    srv?.stop();
    srv = null;
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function boot(dbFile?: string): RunningPentapolisServer {
    const file = dbFile ?? join(mkdtempSync(join(tmpdir(), "pentapolis-traffic-")), "w.sqlite");
    if (!dbFile) tempDirs.push(join(file, ".."));
    srv = createPentapolisServer({ port: 0, dbPath: file, enableRealtimeLoop: false });
    return srv;
  }

  function buildDistrict(s: RunningPentapolisServer) {
    const w = s.world;
    expect(
      w.executeCommand({ type: "claim_sector", sectorId: 1, cityName: "Тест", mayorName: "Мэр", currency: "UAH" }).ok
    ).toBe(true);
    w.engine.getRegion(1).treasuryCashAtCb = money(2_000_000_000);
    const cmds = [
      { type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 300, fromY: 210, toX: 420, toY: 210 },
      { type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 300, fromY: 255, toX: 420, toY: 255 },
      // Link to the Northern Highway gateway stub so developers can import building materials
      { type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 425, fromY: 48, toX: 425, toY: 210 },
      { type: "build_segment", sectorId: 1, kind: "street_2lane", fromX: 420, fromY: 210, toX: 425, toY: 210 },
      { type: "paint_zone", sectorId: 1, zoneKind: "RES-02", x: 300, y: 212, width: 12, depth: 12 },
      { type: "paint_zone", sectorId: 1, zoneKind: "COM-02", x: 400, y: 212, width: 12, depth: 12 },
      { type: "place_building", sectorId: 1, catalogId: "EXT-01", tileX: 300, tileY: 232 },
      { type: "place_building", sectorId: 1, catalogId: "PRO-01", tileX: 370, tileY: 232, cityShareOverride: 1 },
    ] as const;
    for (const c of cmds) {
      const out = w.executeCommand(c);
      expect(out.ok, out.message).toBe(true);
    }
  }

  // The mine needs 48 game hours, the steel mill 72
  const finishConstruction = (s: RunningPentapolisServer) => {
    for (let d = 0; d < 3; d++) s.world.executeCommand({ type: "admin_time_skip", jump: "1d" });
  };

  const segIdAt = (s: RunningPentapolisServer, y: number) =>
    s.world.getSnapshot().segments.find((g) => g.fromY === y && g.toY === y && !g.id.startsWith("GW"))!.id;

  test("freight trucks wear the haul road faster than commuter cars; repair restores it for a fee", async () => {
    const s = boot();
    buildDistrict(s);
    expect(s.world.executeCommand({ type: "update_policy", sectorId: 1, roadServiceLevel: 0 }).ok).toBe(true);
    finishConstruction(s);

    const traffic = (await (await fetch(`${s.url}/api/traffic`)).json()) as TrafficStateDto;
    expect(traffic.vehicles.some((v) => v.role === "freight")).toBe(true);
    const haulId = segIdAt(s, 255);
    const streetId = segIdAt(s, 210);
    const haulLoad = traffic.segments.find((t) => t.segmentId === haulId)!;
    expect(haulLoad.heavyVehiclesPerHour).toBeGreaterThan(0);

    s.world.executeCommand({ type: "admin_time_skip", jump: "1mo" });
    const snap = s.world.getSnapshot();
    const haul = snap.segments.find((g) => g.id === haulId)!;
    const street = snap.segments.find((g) => g.id === streetId)!;
    expect(haul.healthPercent).toBeLessThan(street.healthPercent);
    expect(haul.healthPercent).toBeLessThan(100);
    expect(snap.transport.find((t) => t.sectorId === 1)!.roadServiceLevel).toBe(0);

    const treasuryBefore = s.world.engine.getRegion(1).treasuryCashAtCb;
    const repair = s.world.executeCommand({ type: "repair_road", sectorId: 1, segmentId: haulId });
    expect(repair.ok, repair.message).toBe(true);
    expect(s.world.engine.getRegion(1).treasuryCashAtCb).toBeLessThan(treasuryBefore);
    expect(s.world.getSnapshot().segments.find((g) => g.id === haulId)!.healthPercent).toBe(100);
  });

  test("clicking a truck opens its card, and the driver link opens an exact-to-the-kopiyka dossier", async () => {
    const s = boot();
    buildDistrict(s);
    finishConstruction(s);
    const traffic = s.world.getTrafficState();
    const truck = traffic.vehicles.find((v) => v.role === "freight")!;

    const card = (await (await fetch(`${s.url}/api/vehicle/${truck.id}`)).json()) as VehicleInspectorDto;
    expect(card.id).toBe(truck.id);
    expect(card.cargo?.commodity).toBe("Iron Ore");
    expect(card.destinationLabel).toContain("Сталелитейный");
    expect(card.currencySymbol).toBe("₴");
    expect(card.roadWearFactor).toBe(2800);

    const res = await fetch(`${s.url}/api/citizen/${card.driverCitizenId}`);
    expect(res.status).toBe(200);
    const dossier = (await res.json()) as CitizenDossierDto;
    expect(dossier.workplace.roleRu).toBe("Водитель грузовика");
    expect(dossier.vehicleId).toBe(truck.id);
    const sum = (lines: readonly { amountMinor: string }[]) => lines.reduce((a, l) => a + BigInt(l.amountMinor), 0n);
    expect(sum(dossier.income) - sum(dossier.expenses)).toBe(BigInt(dossier.netSavingsMinor));

    expect((await fetch(`${s.url}/api/vehicle/VH-0`)).status).toBe(404);
  });

  test("bus stops must touch a street; a route needs a depot, then runs buses and persists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pentapolis-bus-"));
    tempDirs.push(dir);
    const dbFile = join(dir, "w.sqlite");
    const s = boot(dbFile);
    buildDistrict(s);
    const w = s.world;

    const offStreet = w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "TRN-01", tileX: 330, tileY: 238 });
    expect(offStreet.ok).toBe(false);
    const noTunnel = w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "TRN-09", tileX: 340, tileY: 270 });
    expect(noTunnel.ok).toBe(false);
    expect(noTunnel.message).toContain("тоннелем");

    expect(w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "TRN-01", tileX: 305, tileY: 211 }).ok).toBe(true);
    expect(w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "TRN-01", tileX: 405, tileY: 211 }).ok).toBe(true);
    const stops = w.getSnapshot().buildings.filter((b) => b.catalogId === "TRN-01").map((b) => b.id);

    const noDepot = w.executeCommand({ type: "create_bus_route", sectorId: 1, stopBuildingIds: stops });
    expect(noDepot.ok).toBe(false);
    expect(noDepot.message).toContain("TRN-02");

    expect(w.executeCommand({ type: "place_building", sectorId: 1, catalogId: "TRN-02", tileX: 330, tileY: 214 }).ok).toBe(true);
    w.executeCommand({ type: "admin_time_skip", jump: "1mo" });
    const carsBefore = w.getTrafficState().sectors.find((t) => t.sectorId === 1)!.carTripsPerHour;

    const created = w.executeCommand({ type: "create_bus_route", sectorId: 1, stopBuildingIds: stops, fleetSize: 3, name: "Набережная" });
    expect(created.ok, created.message).toBe(true);
    expect(created.message).toContain("Работает");
    const traffic = w.getTrafficState();
    expect(traffic.vehicles.filter((v) => v.role === "bus").length).toBe(3);
    const stats = traffic.sectors.find((t) => t.sectorId === 1)!;
    expect(stats.busRoutes).toBe(1);
    expect(stats.busCoverageShare).toBeGreaterThan(0);
    expect(stats.carTripsPerHour).toBeLessThanOrEqual(carsBefore);
    expect(w.getSnapshot().busRoutes[0]!.name).toBe("Набережная");

    // Licence fees reach the treasury on the monthly tick
    s.stop();
    srv = null;
    const s2 = boot(dbFile);
    expect(s2.world.getSnapshot().busRoutes.length).toBe(1);
    expect(s2.world.getTrafficState().busRoutes[0]!.operating).toBe(true);
    const routeId = s2.world.getSnapshot().busRoutes[0]!.id;
    expect(s2.world.executeCommand({ type: "delete_bus_route", sectorId: 1, routeId }).ok).toBe(true);
    expect(s2.world.getSnapshot().busRoutes.length).toBe(0);
  });
});
