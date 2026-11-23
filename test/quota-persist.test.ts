/**
 * dsh-web-tools — coalesced quota persistence tests.
 *
 * Brave changes its quota snapshot on nearly every search, and on DSH 0.1.7 a
 * settings write costs seconds (profile patch + Loader reconciliation under
 * hmr.runExclusive). Persisting per search for a display-only value would run
 * that path continuously and contend with the user's own edits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createQuotaPersistScheduler,
  quotaSnapshotChanged,
} from "../src/host/quota-persist.ts";
import { mergePoolQuota, type QuotaSnapshot } from "../src/host/quota.ts";
import { BraveQuotaManager, braveCacheKeyOf, braveQuotaFromHeaders } from "../src/host/providers/brave.ts";
import { youQuota } from "../src/host/providers/you.ts";
import { hintOf, keyIdOf } from "../src/host/pool.ts";

function snapshot(remaining: number): QuotaSnapshot {
  return {
    supported: true,
    authoritative: true,
    unit: "requests",
    source: "header",
    fetchedAt: 1_700_000_000_000,
    remaining,
    limit: 20000,
  } as QuotaSnapshot;
}

test("quotaSnapshotChanged compares by value, not identity", () => {
  assert.equal(quotaSnapshotChanged(snapshot(10), snapshot(10)), false);
  assert.equal(quotaSnapshotChanged(snapshot(10), snapshot(11)), true);
  assert.equal(quotaSnapshotChanged(undefined, snapshot(10)), true);
  assert.equal(quotaSnapshotChanged(snapshot(10), undefined), true);
});

test("coalesces many search-driven records into one write per window", () => {
  const writes: Array<Record<string, QuotaSnapshot>> = [];
  const scheduler = createQuotaPersistScheduler((cache) => writes.push(cache), {
    delayMs: 60_000,
  });

  // Ten searches, each reporting a slightly different remaining balance.
  for (let i = 1; i <= 10; i += 1) scheduler.record("brave-key-1", snapshot(100 - i));

  assert.equal(writes.length, 0, "nothing is written until the window elapses");
  assert.deepEqual(scheduler.pendingKeys(), ["brave-key-1"]);

  scheduler.flushNow();
  assert.equal(writes.length, 1, "ten searches collapse into a single write");
  assert.equal((writes[0]["brave-key-1"] as QuotaSnapshot).remaining, 90);
});

test("an unchanged snapshot never schedules a write", () => {
  const writes: Array<Record<string, QuotaSnapshot>> = [];
  const scheduler = createQuotaPersistScheduler((cache) => writes.push(cache), {
    delayMs: 60_000,
  });

  scheduler.record("k", snapshot(50));
  scheduler.flushNow();
  assert.equal(writes.length, 1);

  // The same balance reported again by the next search must not write.
  scheduler.record("k", snapshot(50));
  assert.deepEqual(scheduler.pendingKeys(), []);
  scheduler.flushNow();
  assert.equal(writes.length, 1, "no redundant write for an identical snapshot");
});

test("seed preserves unrelated keys loaded from settings", () => {
  const writes: Array<Record<string, QuotaSnapshot>> = [];
  const scheduler = createQuotaPersistScheduler((cache) => writes.push(cache), {
    delayMs: 60_000,
  });

  scheduler.seed({ "other-key": snapshot(7) });
  scheduler.record("brave-key-1", snapshot(3));
  scheduler.flushNow();

  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0]).sort(), ["brave-key-1", "other-key"]);
  assert.equal((writes[0]["other-key"] as QuotaSnapshot).remaining, 7, "seeded key survives");
});

test("dispose flushes pending state so teardown loses nothing", () => {
  const writes: Array<Record<string, QuotaSnapshot>> = [];
  const scheduler = createQuotaPersistScheduler((cache) => writes.push(cache), {
    delayMs: 60_000,
  });

  scheduler.record("k", snapshot(1));
  assert.equal(writes.length, 0);
  scheduler.dispose();
  assert.equal(writes.length, 1, "teardown persists the last known balance");
});

test("the quiet window elapses and flushes once, without a manual flush", async () => {
  const writes: Array<Record<string, QuotaSnapshot>> = [];
  const scheduler = createQuotaPersistScheduler((cache) => writes.push(cache), {
    delayMs: 20,
  });

  scheduler.record("k", snapshot(1));
  scheduler.record("k", snapshot(2));
  assert.equal(writes.length, 0, "still inside the quiet window");

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(writes.length, 1, "the window elapses and writes exactly once");
  assert.equal((writes[0].k as QuotaSnapshot).remaining, 2, "the newest snapshot wins");
});

test("empty api key is ignored", () => {
  const writes: Array<Record<string, QuotaSnapshot>> = [];
  const scheduler = createQuotaPersistScheduler((cache) => writes.push(cache), {
    delayMs: 60_000,
  });
  scheduler.record("", snapshot(1));
  scheduler.flushNow();
  assert.equal(writes.length, 0);
});

test("BraveQuotaManager hashes raw keys with keyIdOf and never persists plaintext keys", async () => {
  const rawKey = "BSA_PLAINTEXT_SECRET_BRAVE_KEY_12345";
  const expectedId = keyIdOf(rawKey);
  assert.match(expectedId, /^[a-f0-9]{12}$/);
  assert.equal(braveCacheKeyOf(rawKey), expectedId);
  assert.equal(braveCacheKeyOf(expectedId), expectedId);

  const persisted: Array<{ key: string; snap: QuotaSnapshot }> = [];
  const mgr = new BraveQuotaManager((key, snap) => persisted.push({ key, snap }));

  const headers = new Headers({
    "x-ratelimit-limit": "1, 15000",
    "x-ratelimit-remaining": "1, 14999",
  });
  mgr.recordFromHeaders(rawKey, headers);

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].key, expectedId);
  assert.notEqual(persisted[0].key, rawKey);
  assert.equal((await mgr.getQuota(rawKey)).remaining, 14999);

  // Restart simulation: seeded by hashed keyId still matches raw key lookup
  const restarted = new BraveQuotaManager();
  restarted.seed(expectedId, snapshot(888));
  assert.equal((await restarted.getQuota(rawKey)).remaining, 888);

  // Legacy migration simulation: seeded by raw key still matches raw key lookup
  const legacy = new BraveQuotaManager();
  legacy.seed(rawKey, snapshot(777));
  assert.equal((await legacy.getQuota(rawKey)).remaining, 777);
});

test("braveQuotaFromHeaders ignores empty monthly segment and missing remaining", () => {
  const emptySecond = braveQuotaFromHeaders(
    new Headers({ "x-ratelimit-limit": "1, 15000", "x-ratelimit-remaining": "1, " }),
    1000,
  );
  assert.equal(emptySecond.limit, 15000);
  assert.equal(emptySecond.remaining, undefined, "empty second segment must not become remaining=0");

  const missingRem = braveQuotaFromHeaders(new Headers({ "x-ratelimit-limit": "1, 15000" }), 1000);
  assert.equal(missingRem.limit, 15000);
  assert.equal(missingRem.remaining, undefined);
});

test("mergePoolQuota computes supported and authoritative via .some across snapshots", () => {
  const merged = mergePoolQuota([
    {
      supported: false,
      authoritative: false,
      unit: "requests",
      source: "dashboard",
      fetchedAt: 1,
    },
    {
      supported: true,
      authoritative: true,
      unit: "requests",
      remaining: 1200,
      limit: 2000,
      source: "response_header",
      fetchedAt: 2,
    },
  ]);
  assert.equal(merged.supported, true);
  assert.equal(merged.authoritative, true);
  assert.equal(merged.source, "response_header");
  assert.equal(merged.remaining, 1200);
  assert.equal(merged.limit, 2000);
});

test("hintOf redacts short keys (<= 8 chars) and caps prefix length at 6", () => {
  assert.equal(hintOf(""), "***");
  assert.equal(hintOf("short"), "***");
  assert.equal(hintOf("12345678"), "***");
  const capped = hintOf("verylongprefix-secret9999");
  assert.equal(capped, "verylo-…9999");
});

test("youQuota returns unsupported immediately for blank apiKey without HTTP", async () => {
  let called = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("should not call fetch");
  }) as typeof globalThis.fetch;
  try {
    const snap = await youQuota("   ");
    assert.equal(called, false);
    assert.equal(snap.supported, false);
    assert.equal(snap.authoritative, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});
