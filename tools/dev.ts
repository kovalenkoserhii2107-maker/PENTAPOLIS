/**
 * Concurrent Development Launcher (`bun dev`).
 *
 * Starts:
 * 1. `@pentapolis/server` (Authoritative Bun HTTP + WebSocket + SQLite WAL on http://localhost:3001)
 * 2. `@pentapolis/client` (Vite + React + Three.js 2:1 Isometric UI on http://localhost:5173)
 */
const serverProc = Bun.spawn(["bun", "run", "--cwd", "apps/server", "dev"], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

const clientProc = Bun.spawn(["bun", "run", "--cwd", "apps/client", "dev"], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

const shutdown = () => {
  serverProc.kill();
  clientProc.kill();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.race([serverProc.exited, clientProc.exited]);
shutdown();
