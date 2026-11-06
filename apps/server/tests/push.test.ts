import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPentapolisServer, type RunningPentapolisServer } from "../src/index.ts";
import type { BrowserPushSubscription } from "../src/push.ts";

describe("Sprint 8: Web Push to the mayor's phone", () => {
  const dirs: string[] = [];
  let srv: RunningPentapolisServer | null = null;

  afterEach(() => {
    srv?.stop();
    srv = null;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const sub = (n: number): BrowserPushSubscription => ({
    endpoint: `https://push.example.test/device-${n}`,
    keys: { p256dh: "BNcR", auth: "tBHI" },
  });

  test("subscribers of a sector get its emergencies; expired subscriptions are dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pentapolis-push-"));
    dirs.push(dir);
    const sent: Array<{ endpoint: string; payload: { title: string; body: string } }> = [];
    let gone = new Set<string>();
    srv = createPentapolisServer({
      port: 0,
      dbPath: join(dir, "w.sqlite"),
      enableRealtimeLoop: false,
      pushSender: async (s, payload) => {
        if (gone.has(s.endpoint)) throw Object.assign(new Error("gone"), { statusCode: 410 });
        sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload) });
        return 201;
      },
    });

    const key = (await (await fetch(`${srv.url}/api/push/public-key`)).json()) as { publicKey: string };
    expect(key.publicKey.length).toBeGreaterThan(40);

    const post = (path: string, body: unknown) =>
      fetch(`${srv!.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/api/push/subscribe", { sectorId: 1, subscription: sub(1) })).status).toBe(200);
    expect((await post("/api/push/subscribe", { sectorId: 2, subscription: sub(2) })).status).toBe(200);
    expect((await post("/api/push/subscribe", { sectorId: 1, subscription: { endpoint: "http://insecure" } })).status).toBe(400);

    srv.world.executeCommand({ type: "claim_sector", sectorId: 1, cityName: "Т", mayorName: "М", currency: "UAH" });
    srv.world.executeCommand({ type: "admin_trigger_emergency", sectorId: 1, emergencyId: "FIRE" });
    await Bun.sleep(20);
    expect(sent.length).toBe(1);
    expect(sent[0]!.endpoint).toBe(sub(1).endpoint);
    expect(sent[0]!.payload.title).toContain("пожар");

    // The push service says the device is gone: it is unsubscribed and not tried again
    gone = new Set([sub(1).endpoint]);
    srv.world.executeCommand({ type: "admin_trigger_emergency", sectorId: 1, emergencyId: "PIPE_BURST" });
    await Bun.sleep(20);
    expect(srv.world.db.loadPushSubscriptions(1)).toEqual([]);
    expect(srv.world.db.loadPushSubscriptions(2).length).toBe(1);

    // The other sector's subscriber still receives pushes
    const again = await srv.push.notifySector(2, { title: "t", body: "b", tag: "x" });
    expect(again).toBe(1);
  });
});
