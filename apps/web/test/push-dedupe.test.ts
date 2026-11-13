import { describe, expect, it, vi } from "vitest";
import {
  MAX_SEEN_DELIVERIES,
  dedupeKey,
  normalizePushPayload,
  rememberDelivery,
  urlBase64ToUint8Array,
  type DedupeCacheLike,
} from "../src/lib/push-dedupe.js";

class FakeCache implements DedupeCacheLike {
  private readonly entries = new Map<string, unknown>();

  async match(key: string): Promise<unknown> {
    return this.entries.get(key);
  }

  async put(key: string, response: unknown): Promise<void> {
    this.entries.set(key, response);
  }

  async keys(): Promise<unknown[]> {
    return [...this.entries.keys()];
  }

  async delete(key: unknown): Promise<boolean> {
    return this.entries.delete(String(key));
  }

  size(): number {
    return this.entries.size;
  }
}

function factory(cache: FakeCache) {
  return async () => cache;
}

describe("service worker push dedupe", () => {
  it("shows a delivery once and suppresses the replay", async () => {
    const cache = new FakeCache();
    const deliveryId = "01900000-0000-7000-8000-0000000000aa";

    expect(await rememberDelivery(factory(cache), deliveryId)).toBe(true);
    expect(await rememberDelivery(factory(cache), deliveryId)).toBe(false);
    expect(cache.size()).toBe(1);
  });

  it("fails open when Cache Storage is unavailable", async () => {
    const result = await rememberDelivery(async () => {
      throw new Error("cache unavailable");
    }, "delivery-1");
    expect(result).toBe(true);
  });

  it("evicts the oldest ids beyond the cap", async () => {
    const cache = new FakeCache();
    for (let index = 0; index < MAX_SEEN_DELIVERIES + 5; index += 1) {
      expect(
        await rememberDelivery(factory(cache), `delivery-${index}`),
      ).toBe(true);
    }
    expect(cache.size()).toBe(MAX_SEEN_DELIVERIES);
    // Oldest ids were evicted, newest remain.
    expect(await cache.match(dedupeKey("delivery-0"))).toBeUndefined();
    expect(
      await cache.match(dedupeKey(`delivery-${MAX_SEEN_DELIVERIES + 4}`)),
    ).toBeDefined();
  });

  it("normalises the payload and keeps unsafe URLs out of notification data", () => {
    const payload = normalizePushPayload({
      title: "Milk",
      body: "Buy milk",
      url: "https://evil.example/steal",
      taskId: "task-1",
      deliveryId: "delivery-1",
      tag: "topic-1",
      badgeCount: 2.8,
      kind: "reminder",
    });
    expect(payload.url).toBe("/today");
    expect(payload.tag).toBe("topic-1");
    expect(payload.badgeCount).toBe(3);
    expect(payload.deliveryId).toBe("delivery-1");

    expect(normalizePushPayload({ url: "/api/secret" }).url).toBe("/today");
    expect(normalizePushPayload({ url: "/tasks/abc" }).url).toBe("/tasks/abc");
  });

  it("decodes the base64url VAPID key used by PushManager", () => {
    const bytes = urlBase64ToUint8Array("AQIDBA");
    expect([...bytes]).toEqual([1, 2, 3, 4]);
  });

  it("never suppresses a delivery without an id", async () => {
    const cache = new FakeCache();
    const cacheFactory = vi.fn(factory(cache));

    expect(await rememberDelivery(cacheFactory, "")).toBe(true);
    expect(cacheFactory).not.toHaveBeenCalled();
    expect(cache.size()).toBe(0);
  });

  it("encodes delivery ids into namespaced cache keys", () => {
    expect(dedupeKey("delivery/with space")).toBe(
      "/__push/delivery%2Fwith%20space",
    );
    expect(dedupeKey("a?b#c")).toBe("/__push/a%3Fb%23c");
  });

  it("supplies safe defaults for an empty payload", () => {
    expect(normalizePushPayload(undefined)).toEqual({
      title: "Morrow",
      body: "A reminder is due.",
      url: "/today",
      deliveryId: "",
      tag: "morrow-reminder",
    });
    expect(
      normalizePushPayload({ title: "   ", kind: "unsupported" }),
    ).toMatchObject({
      title: "Morrow",
      url: "/today",
    });
  });

  it("clamps oversized fields and rejects unsafe nav targets", () => {
    const long = "x".repeat(2_000);
    const payload = normalizePushPayload({
      title: long,
      body: long,
      taskId: long,
      deliveryId: "delivery-9",
      tag: " ",
      badgeCount: 0,
      kind: "digest",
      url: "//evil.example/phish",
    });

    expect(payload.title).toHaveLength(120);
    expect(payload.body).toHaveLength(800);
    expect(payload.taskId).toHaveLength(120);
    expect(payload.tag).toBe("morrow-digest");
    expect(payload.badgeCount).toBe(0);
    expect(payload.kind).toBe("digest");
    expect(payload.url).toBe("/today");
    expect(normalizePushPayload({ url: "/events?lastEventId=1" }).url).toBe(
      "/today",
    );
    expect(normalizePushPayload({ url: "/tasks/abc" }).url).toBe("/tasks/abc");
    expect(
      normalizePushPayload({ taskRev: 7, taskId: "task-1" }).taskRev,
    ).toBe(7);
  });

  it("decodes unpadded and url-safe base64 bytes", () => {
    expect([...urlBase64ToUint8Array("SGVsbG8")]).toEqual([
      ...new TextEncoder().encode("Hello"),
    ]);
    expect([...urlBase64ToUint8Array("-_8")]).toEqual([251, 255]);
  });

  it("coalesces untagged digests under one tag, singles under their delivery", () => {
    expect(
      normalizePushPayload({ kind: "digest", body: "3 due today" }).tag,
    ).toBe("morrow-digest");
    expect(
      normalizePushPayload({ kind: "digest", deliveryId: "d-1" }).tag,
    ).toBe("morrow-digest");
    expect(normalizePushPayload({ kind: "reminder" }).tag).toBe(
      "morrow-reminder",
    );
  });
});
