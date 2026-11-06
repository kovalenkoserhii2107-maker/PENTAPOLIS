/**
 * Where the authoritative server lives (Sprint 8 deployment).
 *
 * Locally Vite proxies `/api` and `/ws` to `localhost:3001`, so relative URLs work. On GitHub Pages
 * the static client and the Fly.io server are on different origins: build with
 * `VITE_SERVER_URL=https://<app>.fly.dev` and every request goes there.
 */
const configured = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/+$/, "") ?? "";

/** Absolute or same-origin URL for an API path such as `/api/snapshot`. */
export function apiUrl(path: string): string {
  return `${configured}${path}`;
}

/** WebSocket URL of the live world feed. */
export function wsUrl(): string {
  if (configured) return `${configured.replace(/^http/, "ws")}/ws`;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}
