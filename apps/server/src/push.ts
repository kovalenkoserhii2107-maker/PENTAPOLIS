/**
 * Web Push for mayors' phones (Sprint 8, GDD §1.4, §8.2).
 *
 * Uses the standard Web Push protocol with VAPID keys. Chrome and Android deliver it through
 * Firebase Cloud Messaging automatically, Safari through Apple Push — no Firebase project needed.
 * Keys come from `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` in production; a
 * development world generates a pair once and keeps it in its database.
 */
import webpush from "web-push";
import type { SectorId } from "@pentapolis/shared-sim";
import type { WorldDatabase } from "./db.ts";

export interface PushPayload {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
}

export interface BrowserPushSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/** Sends one push; resolves with the push service's HTTP status. */
export type PushSender = (subscription: BrowserPushSubscription, payload: string) => Promise<number>;

export class PushService {
  public readonly publicKey: string;
  private readonly send: PushSender;

  constructor(
    private readonly db: WorldDatabase,
    sender?: PushSender
  ) {
    const fromEnv = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY;
    let keys = fromEnv
      ? { publicKey: process.env.VAPID_PUBLIC_KEY!, privateKey: process.env.VAPID_PRIVATE_KEY! }
      : (JSON.parse(db.getMeta("vapidKeys") ?? "null") as { publicKey: string; privateKey: string } | null);
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      db.setMeta("vapidKeys", JSON.stringify(keys));
    }
    this.publicKey = keys.publicKey;
    const subject = process.env.VAPID_SUBJECT ?? "mailto:mayors@pentapolis.invalid";
    this.send =
      sender ??
      (async (subscription, payload) => {
        const res = await webpush.sendNotification(subscription, payload, {
          vapidDetails: { subject, publicKey: keys!.publicKey, privateKey: keys!.privateKey },
          TTL: 6 * 3600,
        });
        return res.statusCode;
      });
  }

  public subscribe(sectorId: SectorId, subscription: BrowserPushSubscription): void {
    if (!subscription?.endpoint?.startsWith("https://") || !subscription.keys?.p256dh || !subscription.keys.auth) {
      throw new Error("Некорректная подписка Web Push");
    }
    this.db.savePushSubscription(subscription.endpoint, sectorId, JSON.stringify(subscription));
  }

  public unsubscribe(endpoint: string): void {
    this.db.deletePushSubscription(endpoint);
  }

  /** Pushes to every device of a sector's mayor; drops subscriptions the push service has expired. */
  public async notifySector(sectorId: SectorId, payload: PushPayload): Promise<number> {
    let delivered = 0;
    for (const row of this.db.loadPushSubscriptions(sectorId)) {
      try {
        const status = await this.send(JSON.parse(row.subscriptionJson) as BrowserPushSubscription, JSON.stringify(payload));
        if (status >= 200 && status < 300) delivered += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) this.db.deletePushSubscription(row.endpoint);
      }
    }
    return delivered;
  }
}
