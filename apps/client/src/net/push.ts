/**
 * Web Push subscription for the mayor's phone (Sprint 8, GDD §1.4: notice windows and emergencies
 * reach the mayor even when the game is closed).
 */
import { apiUrl } from "./serverUrl.ts";

export type PushState = "unsupported" | "off" | "on" | "denied";

function base64UrlToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentPushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

/** Asks permission, subscribes this device and registers it for the sector's alerts. */
export async function enablePush(sectorId: number): Promise<PushState> {
  if ((await currentPushState()) === "unsupported") return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = (await (await fetch(apiUrl("/api/push/public-key"))).json()) as { publicKey: string };
  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) }));
  const res = await fetch(apiUrl("/api/push/subscribe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sectorId, subscription: subscription.toJSON() }),
  });
  return res.ok ? "on" : "off";
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await fetch(apiUrl("/api/push/unsubscribe"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  }
  return "off";
}
