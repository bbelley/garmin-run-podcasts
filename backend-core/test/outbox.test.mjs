import test from "node:test";
import assert from "node:assert/strict";
import { D1Store } from "../src/store.mjs";
import { PocketCastsError, deliverOne } from "../src/outbox.mjs";
import { SqliteD1, fixtureItems, eventFor } from "./support.mjs";

async function setup(t) {
    const db = new SqliteD1();
    t.after(() => db.close());
    const store = new D1Store(db);
    const { items } = await fixtureItems();
    await store.saveCatalog(items);
    await store.recordCompletions("watch", [eventFor(items[0])], 100);
    return { store, db };
}

test("delivery reads before writing and verifies the result afterward", async t => {
    const { store, db } = await setup(t);
    const calls = [];
    let played = false;
    const adapter = { isPlayed: async () => { calls.push("read"); return played; },
        markPlayed: async () => { calls.push("write"); played = true; } };
    assert.deepEqual(await deliverOne(store, adapter, 200), { status: "delivered" });
    assert.deepEqual(calls, ["read", "write", "read"]);
    assert.equal(db.rows("pocket_casts_outbox")[0].state, "delivered");
    assert.deepEqual(await deliverOne(store, adapter, 201), { status: "idle" });
});

test("an episode already played needs no write", async t => {
    const { store } = await setup(t);
    assert.deepEqual(await deliverOne(store, { isPlayed: async () => true,
        markPlayed: async () => assert.fail("Unexpected played write") }, 200), { status: "delivered" });
});

test("a lost write response is verified by immediate readback", async t => {
    const { store, db } = await setup(t);
    let played = false;
    let writes = 0;
    const adapter = { isPlayed: async () => played, markPlayed: async () => {
        writes += 1; played = true; throw new Error("private upstream detail");
    } };
    assert.deepEqual(await deliverOne(store, adapter, 200), { status: "delivered" });
    assert.equal(writes, 1);
    assert.equal(db.rows("pocket_casts_outbox")[0].state, "delivered");
});

test("a lost write response and failed readback retry by reading before another write", async t => {
    const { store, db } = await setup(t);
    let played = false;
    let reads = 0;
    let writes = 0;
    const adapter = { isPlayed: async () => {
        reads += 1;
        if (reads === 2) throw new Error("Readback unavailable");
        return played;
    }, markPlayed: async () => {
        writes += 1; played = true; throw new Error("Write response unavailable");
    } };
    assert.equal((await deliverOne(store, adapter, 200)).status, "retry_required");
    assert.equal(db.rows("pocket_casts_outbox")[0].next_attempt_at, 230);
    assert.equal(db.rows("pocket_casts_outbox")[0].last_error, "retry_required");
    assert.equal((await deliverOne(store, adapter, 229)).status, "idle");
    assert.equal((await deliverOne(store, adapter, 230)).status, "delivered");
    assert.equal(writes, 1);
});

test("an unknown played state defers delivery before issuing a write", async t => {
    const { store } = await setup(t);
    const adapter = { isPlayed: async () => null,
        markPlayed: async () => assert.fail("Unknown state must not cause a write") };
    assert.equal((await deliverOne(store, adapter, 200)).status, "retry_required");
});

test("unconfirmed played state stays pending", async t => {
    const { store, db } = await setup(t);
    assert.equal((await deliverOne(store, { isPlayed: async () => false, markPlayed: async () => {} }, 200)).status, "retry_required");
    assert.equal(db.rows("pocket_casts_outbox")[0].state, "pending");
    assert.deepEqual(await store.completedIds(), [db.rows("completions")[0].item_id]);
});

test("expired authentication waits for reconnection without losing completion", async t => {
    const { store, db } = await setup(t);
    const adapter = { isPlayed: async () => { throw new PocketCastsError("auth_required"); } };
    assert.equal((await deliverOne(store, adapter, 200)).status, "auth_required");
    assert.equal((await deliverOne(store, adapter, 10000)).status, "idle");
    assert.equal(db.rows("completions").length, 1);
    await store.resumeDeliveries(10001);
    assert.equal((await deliverOne(store, { isPlayed: async () => true }, 10001)).status, "delivered");
});

test("server Retry-After is respected", async t => {
    const { store, db } = await setup(t);
    const adapter = { isPlayed: async () => { throw new PocketCastsError("rate_limited", 7200); } };
    await deliverOne(store, adapter, 200);
    assert.ok(db.rows("pocket_casts_outbox")[0].next_attempt_at >= 7400);
});

test("concurrent workers claim a delivery once, and expired leases recover", async t => {
    const { store } = await setup(t);
    const claims = await Promise.all([store.claimDelivery(200), store.claimDelivery(200)]);
    const original = claims.find(Boolean);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await store.claimDelivery(319), null);
    const recovered = await store.claimDelivery(320);
    assert.notEqual(recovered.lease_token, original.lease_token);
    assert.equal(recovered.attempts, 2);
});

test("a stale worker cannot finish or fail another worker's lease", async t => {
    const { store, db } = await setup(t);
    const original = await store.claimDelivery(200);
    const recovered = await store.claimDelivery(320);
    await store.finishDelivery(original, 321);
    await store.failDelivery(original, 322, "retry_required");
    assert.equal(db.rows("pocket_casts_outbox")[0].lease_token, recovered.lease_token);
    assert.equal(db.rows("pocket_casts_outbox")[0].state, "processing");
    await store.finishDelivery(recovered, 323);
    assert.equal(db.rows("pocket_casts_outbox")[0].state, "delivered");
});
