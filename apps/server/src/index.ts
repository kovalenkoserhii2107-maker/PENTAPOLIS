/**
 * Authoritative Bun HTTP + WebSocket Server (`@pentapolis/server`, default port `3001`).
 *
 * Serves:
 * - `GET  /api/health`   — Server health, world clock, double-entry invariant status
 * - `GET  /api/catalogs` — Master catalogs (127 buildings, 24 chains, 56 vehicles, 8 decrees, 12 emergencies, 16 currencies)
 * - `GET  /api/map-meta` — Peninsula metadata, sector land counts, 5 gateways, 25 resource deposits
 * - `GET  /api/map.bin`  — Binary `2,000,000`-byte buffer (`surface[1,000,000]` + `owner[1,000,000]`) for <5ms load
 * - `GET  /api/snapshot` — Full `WorldSnapshotDto`
 * - `GET  /api/traffic`  — Live `TrafficStateDto` (sampled vehicles, segment loads & wear, transit stats)
 * - `GET  /api/vehicle/:id` — Vehicle inspector card (owner, route, cargo, speed, wear, driver link)
 * - `GET  /api/citizen/:id` — Citizen dossier (identity, home/work, monthly ledger, thoughts)
 * - `POST /api/command`  — Execute a `ClientCommand` over REST & broadcast updated snapshot
 * - `WS   /ws`           — Live multiplayer state & command sync
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  CANONICAL_DECREES,
  CANONICAL_EMERGENCIES,
  DEFAULT_MAYOR_LEVERS,
  NATIONAL_CURRENCIES,
  WORLD_CURRENCY,
  type ClientCommand,
  type ServerMessage,
} from "@pentapolis/shared-sim";
import { WorldSimulation } from "./worldServer.ts";
import { PushService, type BrowserPushSubscription, type PushSender } from "./push.ts";

export interface PentapolisServerOptions {
  readonly port?: number;
  readonly dbPath?: string;
  readonly worldId?: string;
  readonly staticDir?: string;
  readonly enableRealtimeLoop?: boolean;
  /** Replaces real Web Push delivery (tests). */
  readonly pushSender?: PushSender;
  /** Catalog items wait for their development stage (default true; tests may build freely). */
  readonly enforceStageUnlocks?: boolean;
}

export interface RunningPentapolisServer {
  readonly world: WorldSimulation;
  readonly push: PushService;
  readonly port: number;
  readonly url: string;
  stop: () => void;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(payload: unknown, status = 200): Response {
  const body = JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export function createPentapolisServer(
  options: PentapolisServerOptions = {}
): RunningPentapolisServer {
  const dbPath =
    options.dbPath ??
    process.env.PENTAPOLIS_DB_PATH ??
    resolve(import.meta.dir, "..", "data", "pentapolis.sqlite");
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const staticDir =
    options.staticDir ?? resolve(import.meta.dir, "..", "..", "client", "dist");
  const world = new WorldSimulation(dbPath, options.worldId);
  world.enforceStageUnlocks = options.enforceStageUnlocks !== false;
  // Phone alerts (GDD §1.4): the simulation never waits for delivery
  const push = new PushService(world.db, options.pushSender);
  world.onMayorAlert = (sectorId, alert) => {
    void push.notifySector(sectorId, alert).catch(() => undefined);
  };
  const clients = new Set<ServerWebSocket<{ connectedAt: number }>>();

  // Prepack binary 2,000,000-byte terrain + sector owner buffer once
  const packedMapBytes = new Uint8Array(world.map.surface.length + world.map.owner.length);
  packedMapBytes.set(world.map.surface, 0);
  packedMapBytes.set(world.map.owner, world.map.surface.length);
  // Revalidated on every load so clients never draw a stale map after the generator changes
  const mapEtag = `"${Bun.hash(packedMapBytes).toString(16)}"`;

  const sendMsg = (ws: ServerWebSocket<{ connectedAt: number }>, msg: ServerMessage) => {
    ws.send(JSON.stringify(msg, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  };

  const broadcast = (msg: ServerMessage) => {
    if (clients.size === 0) return;
    const raw = JSON.stringify(msg, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const ws of clients) {
      ws.send(raw);
    }
  };

  let lastBroadcastTrafficVersion = -1;
  const broadcastSnapshot = () => {
    if (clients.size === 0) return;
    broadcast({ type: "world_snapshot", snapshot: world.getSnapshot() });
    // Vehicle paths only travel when the tactical tick or a command re-routed traffic
    const version = world.getTrafficVersion();
    if (version !== lastBroadcastTrafficVersion) {
      lastBroadcastTrafficVersion = version;
      broadcast({ type: "traffic_state", traffic: world.getTrafficState() });
    }
  };

  const server = Bun.serve<{ connectedAt: number }>({
    port: options.port ?? Number(process.env.PORT ?? 3001),
    fetch(req, srv) {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const upgraded = srv.upgrade(req, { data: { connectedAt: Date.now() } });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400, headers: CORS_HEADERS });
      }

      if (url.pathname === "/api/health" && req.method === "GET") {
        const snap = world.getSnapshot();
        return jsonResponse({
          ok: true,
          worldId: snap.worldId,
          seasonDay: snap.seasonDay,
          calendar: snap.calendar,
          invariantAllZero: snap.invariantAllZero,
          sqliteJournalMode: world.db.getJournalMode(),
        });
      }

      if (url.pathname === "/api/catalogs" && req.method === "GET") {
        return jsonResponse({
          unitsAndTime: world.catalogs.unitsAndTime,
          commodities: world.catalogs.commodities,
          stages: world.catalogs.stages,
          buildings: world.catalogs.buildings,
          vehicles: world.catalogs.vehicles,
          sectors: world.catalogs.sectors,
          decrees: CANONICAL_DECREES,
          emergencies: CANONICAL_EMERGENCIES,
          levers: DEFAULT_MAYOR_LEVERS,
          currencies: NATIONAL_CURRENCIES,
          wcu: WORLD_CURRENCY,
        });
      }

      if (url.pathname === "/api/map-meta" && req.method === "GET") {
        return jsonResponse({
          width: world.map.width,
          height: world.map.height,
          sectorLandTiles: world.map.sectorLandTiles,
          centralCoreTiles: world.map.centralCoreTiles,
          gateways: world.map.gateways,
          deposits: world.map.deposits,
        });
      }

      if (url.pathname === "/api/map.bin" && req.method === "GET") {
        const cacheHeaders = { ...CORS_HEADERS, ETag: mapEtag, "Cache-Control": "no-cache" };
        if (req.headers.get("If-None-Match") === mapEtag) {
          return new Response(null, { status: 304, headers: cacheHeaders });
        }
        return new Response(packedMapBytes, {
          status: 200,
          headers: { ...cacheHeaders, "Content-Type": "application/octet-stream" },
        });
      }

      if (url.pathname === "/api/snapshot" && req.method === "GET") {
        return jsonResponse(world.getSnapshot());
      }

      if (url.pathname === "/api/traffic" && req.method === "GET") {
        return jsonResponse(world.getTrafficState());
      }

      if (url.pathname.startsWith("/api/vehicle/") && req.method === "GET") {
        const id = decodeURIComponent(url.pathname.slice("/api/vehicle/".length));
        const card = world.inspectVehicle(id);
        return card
          ? jsonResponse(card)
          : jsonResponse({ ok: false, error: `Транспорт ${id} уже покинул карту` }, 404);
      }

      if (url.pathname.startsWith("/api/citizen/") && req.method === "GET") {
        const id = decodeURIComponent(url.pathname.slice("/api/citizen/".length));
        const dossier = world.getCitizenDossier(id);
        return dossier
          ? jsonResponse(dossier)
          : jsonResponse({ ok: false, error: `Гражданин ${id} не найден` }, 404);
      }

      if (url.pathname === "/api/push/public-key" && req.method === "GET") {
        return jsonResponse({ publicKey: push.publicKey });
      }

      if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
        return req
          .json()
          .then((body) => {
            const { sectorId, subscription } = body as { sectorId: number; subscription: BrowserPushSubscription };
            if (![1, 2, 3, 4, 5].includes(sectorId)) throw new Error("Неизвестный сектор");
            push.subscribe(sectorId as 1 | 2 | 3 | 4 | 5, subscription);
            return jsonResponse({ ok: true });
          })
          .catch((err: unknown) => jsonResponse({ ok: false, error: err instanceof Error ? err.message : "Bad request" }, 400));
      }

      if (url.pathname === "/api/push/unsubscribe" && req.method === "POST") {
        return req
          .json()
          .then((body) => {
            push.unsubscribe(String((body as { endpoint: string }).endpoint));
            return jsonResponse({ ok: true });
          })
          .catch(() => jsonResponse({ ok: false }, 400));
      }

      if (url.pathname === "/api/command" && req.method === "POST") {
        return req
          .json()
          .then((rawCmd) => {
            const outcome = world.executeCommand(rawCmd as ClientCommand);
            if (outcome.noticeAlerts) {
              for (const alert of outcome.noticeAlerts) {
                broadcast({ type: "notice_alert", message: alert });
              }
            }
            broadcastSnapshot();
            return jsonResponse({
              ok: outcome.ok,
              message: outcome.message,
              snapshot: world.getSnapshot(),
            });
          })
          .catch((err: unknown) =>
            jsonResponse(
              { ok: false, message: err instanceof Error ? err.message : "Invalid JSON command" },
              400
            )
          );
      }

      if (url.pathname.startsWith("/api/")) {
        return jsonResponse({ ok: false, error: `Not found: ${url.pathname}` }, 404);
      }

      // Production Static SPA Serving from `apps/client/dist` with SPA fallback to `index.html`
      if ((req.method === "GET" || req.method === "HEAD") && existsSync(staticDir)) {
        const relPath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
        const candidate = resolve(staticDir, relPath);
        if (candidate.startsWith(staticDir) && existsSync(candidate) && statSync(candidate).isFile()) {
          const isHashedAsset = url.pathname.startsWith("/assets/");
          const file = Bun.file(candidate);
          return new Response(file, {
            status: 200,
            headers: {
              "Content-Type": file.type || "application/octet-stream",
              "Cache-Control": isHashedAsset
                ? "public, max-age=31536000, immutable"
                : "no-cache",
            },
          });
        }
        const indexHtml = resolve(staticDir, "index.html");
        if (existsSync(indexHtml)) {
          const file = Bun.file(indexHtml);
          return new Response(file, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        }
      }

      return jsonResponse({ ok: false, error: `Not found: ${url.pathname}` }, 404);
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        sendMsg(ws, { type: "world_snapshot", snapshot: world.getSnapshot() });
        sendMsg(ws, { type: "traffic_state", traffic: world.getTrafficState() });
      },
      message(ws, raw) {
        try {
          const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
          const cmd = JSON.parse(text) as ClientCommand;
          const outcome = world.executeCommand(cmd);
          sendMsg(ws, { type: "command_result", ok: outcome.ok, message: outcome.message });
          if (outcome.noticeAlerts) {
            for (const alert of outcome.noticeAlerts) {
              broadcast({ type: "notice_alert", message: alert });
            }
          }
          broadcastSnapshot();
        } catch (err) {
          sendMsg(ws, {
            type: "command_result",
            ok: false,
            message: err instanceof Error ? err.message : "Ошибка обработки команды",
          });
        }
      },
      close(ws) {
        clients.delete(ws);
      },
    },
  });

  // 5-tier real-time micro-tick (`1s` real = `30s` game time, GDD §1.4); the world re-routes
  // traffic on the Tier 3 tactical tick (every 20 real seconds = 600 game seconds)
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let microTickCounter = 0;
  if (options.enableRealtimeLoop !== false) {
    const gameSecPerTick = world.catalogs.unitsAndTime.timeBase.gameSecondsPerMicroTick;
    tickTimer = setInterval(() => {
      microTickCounter += 1;
      const alerts = world.advanceGameSeconds(gameSecPerTick);
      for (const alert of alerts) {
        broadcast({ type: "notice_alert", message: alert });
      }
      // Broadcast world snapshot every 5 real seconds (or immediately on alerts) to keep bandwidth crisp
      if (microTickCounter % 5 === 0 || alerts.length > 0) {
        broadcastSnapshot();
      }
    }, 1000);
  }

  const resolvedPort = server.port ?? 3001;
  return {
    world,
    push,
    port: resolvedPort,
    url: `http://localhost:${resolvedPort}`,
    stop: () => {
      if (tickTimer) clearInterval(tickTimer);
      server.stop(true);
      world.close();
    },
  };
}

if (import.meta.main) {
  const srv = createPentapolisServer();
  console.log(
    `[PENTAPOLIS Server] Authoritative simulation running on ${srv.url} (SQLite: ${srv.world.db.getJournalMode()})`
  );
}
export { WorldSimulation } from "./worldServer.ts";
export { WorldDatabase } from "./db.ts";
