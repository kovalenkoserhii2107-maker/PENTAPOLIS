import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPentapolisServer, type RunningPentapolisServer } from "../src/index.ts";

describe("Authoritative Pentapolis Server & SQLite WAL Persistence (Sprint 3)", () => {
  const tempDirs: string[] = [];
  let activeServer: RunningPentapolisServer | null = null;

  afterEach(() => {
    if (activeServer) {
      activeServer.stop();
      activeServer = null;
    }
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("enforces unique national currencies, mandatory Hryvnia (₴ UAH) on 5th slot, and WAL mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pentapolis-srv-"));
    tempDirs.push(dir);
    const dbFile = join(dir, "test.sqlite");

    activeServer = createPentapolisServer({
      port: 0,
      dbPath: dbFile,
      enableRealtimeLoop: false,
    });

    const healthRes = await fetch(`${activeServer.url}/api/health`);
    const health = (await healthRes.json()) as {
      ok: boolean;
      invariantAllZero: boolean;
      sqliteJournalMode: string;
    };
    expect(health.ok).toBe(true);
    expect(health.invariantAllZero).toBe(true);
    expect(health.sqliteJournalMode.toLowerCase()).toBe("wal");

    // Claim S1..S4 WITHOUT UAH
    const nonUah = ["PLN", "KR", "FLR", "DUC"] as const;
    for (let i = 0; i < 4; i++) {
      const s = (i + 1) as 1 | 2 | 3 | 4;
      const out = activeServer.world.executeCommand({
        type: "claim_sector",
        sectorId: s,
        cityName: `Город-${s}`,
        mayorName: `Мэр-${s}`,
        currency: nonUah[i]!,
      });
      expect(out.ok).toBe(true);
    }

    // Duplicate currency rejected
    const dup = activeServer.world.executeCommand({
      type: "claim_sector",
      sectorId: 5,
      cityName: "Восток",
      mayorName: "Мэр-5",
      currency: "PLN",
    });
    expect(dup.ok).toBe(false);

    // 5th slot without UAH rejected because UAH is mandatory in every 5-region season (GDD §3.2)
    const noUahFifth = activeServer.world.executeCommand({
      type: "claim_sector",
      sectorId: 5,
      cityName: "Восток",
      mayorName: "Мэр-5",
      currency: "TLR",
    });
    expect(noUahFifth.ok).toBe(false);

    // Selecting UAH (₴) on the 5th slot succeeds!
    const validFifth = activeServer.world.executeCommand({
      type: "claim_sector",
      sectorId: 5,
      cityName: "Нова Гавань",
      mayorName: "Мэр-5",
      currency: "UAH",
    });
    expect(validFifth.ok).toBe(true);
  });

  test("supports 90°/45° roads, 10%/90% factory buyout, Eminent Domain check, Notice Window, +1mo skip, and SQLite reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pentapolis-persist-"));
    tempDirs.push(dir);
    const dbFile = join(dir, "world.sqlite");

    activeServer = createPentapolisServer({
      port: 0,
      dbPath: dbFile,
      enableRealtimeLoop: false,
    });

    // Claim Sector 1 with Hryvnia (₴ UAH) -> $10,000,000 greenfield treasury
    expect(
      activeServer.world.executeCommand({
        type: "claim_sector",
        sectorId: 1,
        cityName: "Североград",
        mayorName: "Сергей",
        currency: "UAH",
      }).ok
    ).toBe(true);

    // Build a 45° diagonal road in Sector 1
    const roadOut = activeServer.world.executeCommand({
      type: "build_segment",
      sectorId: 1,
      kind: "avenue_4lane",
      fromX: 350,
      fromY: 280,
      toX: 365,
      toY: 295,
    });
    expect(roadOut.ok).toBe(true);

    // Place a Tier-2 Steel Mill (`PRO-01`, co_invested_10_90) in Sector 1
    // First hike keyRate to 25% so private investors refuse 90% -> triggers stalled site!
    activeServer.world.executeCommand({
      type: "update_policy",
      sectorId: 1,
      keyRate: 0.25,
    });

    const plantOut = activeServer.world.executeCommand({
      type: "place_building",
      sectorId: 1,
      catalogId: "PRO-01",
      tileX: 380,
      tileY: 250,
    });
    expect(plantOut.ok).toBe(true);

    let snap = activeServer.world.getSnapshot();
    const steelMill = snap.buildings.find((b) => b.catalogId === "PRO-01");
    expect(steelMill).toBeDefined();
    expect(steelMill!.stalledAwaitingPrivate).toBe(true);
    expect(steelMill!.cityEquityShare).toBeCloseTo(0.1, 2);

    // Mayor invokes 100% Municipal Buyout Backstop
    const buyout = activeServer.world.executeCommand({
      type: "buyout_factory",
      sectorId: 1,
      buildingId: steelMill!.id,
    });
    expect(buyout.ok).toBe(true);

    snap = activeServer.world.getSnapshot();
    const boughtMill = snap.buildings.find((b) => b.id === steelMill!.id)!;
    expect(boughtMill.stalledAwaitingPrivate).toBe(false);
    expect(boughtMill.cityEquityShare).toBe(1.0);

    // Lower keyRate back to 5% and place a second co-invested plant (`PRO-03`) where private investors DO take 90%
    activeServer.world.executeCommand({
      type: "update_policy",
      sectorId: 1,
      keyRate: 0.05,
    });
    expect(
      activeServer.world.executeCommand({
        type: "place_building",
        sectorId: 1,
        catalogId: "PRO-03",
        tileX: 330,
        tileY: 240,
      }).ok
    ).toBe(true);

    const jointPlant = activeServer.world
      .getSnapshot()
      .buildings.find((b) => b.catalogId === "PRO-03")!;
    expect(jointPlant.stalledAwaitingPrivate).toBe(false);
    expect(jointPlant.cityEquityShare).toBeCloseTo(0.1, 2);

    // Eminent Domain check: cannot bulldoze a 10%/90% plant without buying out private shareholders first
    const illegalBulldoze = activeServer.world.executeCommand({
      type: "bulldoze_building",
      sectorId: 1,
      buildingId: jointPlant.id,
    });
    expect(illegalBulldoze.ok).toBe(false);

    // Hostile tariff > 50% triggers Notice Window instead of immediate shock
    const tariffRes = activeServer.world.executeCommand({
      type: "update_policy",
      sectorId: 1,
      importDutyRate: 0.75,
    });
    expect(tariffRes.ok).toBe(true);
    expect(tariffRes.noticeAlerts?.length).toBe(1);
    expect(activeServer.world.engine.getRegion(1).levers.importDutyRate).toBe(0.06);

    // Time-skip +1mo -> activates notice window AND closes all 5 monthly matrices with 0n discrepancy
    const skipOut = activeServer.world.executeCommand({
      type: "admin_time_skip",
      jump: "1mo",
    });
    expect(skipOut.ok).toBe(true);
    expect(activeServer.world.engine.getRegion(1).levers.importDutyRate).toBe(0.75);

    const afterSkip = activeServer.world.getSnapshot();
    expect(afterSkip.invariantAllZero).toBe(true);
    expect(afterSkip.calendar.economicMonth).toBe(2);

    // Binary map endpoint returns exact 2,000,000 bytes
    const binRes = await fetch(`${activeServer.url}/api/map.bin`);
    const buf = await binRes.arrayBuffer();
    expect(buf.byteLength).toBe(2_000_000);

    // Close server and reload from the same SQLite database file -> state persists!
    activeServer.stop();
    activeServer = createPentapolisServer({
      port: 0,
      dbPath: dbFile,
      enableRealtimeLoop: false,
    });
    const reloaded = activeServer.world.getSnapshot();
    expect(reloaded.sectors[0]!.occupied).toBe(true);
    expect(reloaded.sectors[0]!.cityName).toBe("Североград");
    expect(reloaded.sectors[0]!.currency).toBe("UAH");
    expect(reloaded.buildings.length).toBe(2);
  });
});
