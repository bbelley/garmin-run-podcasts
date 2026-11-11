import test from "node:test";
import assert from "node:assert/strict";
import { D1Store } from "../src/store.mjs";
import { syncWatch } from "../src/sync.mjs";
import { SqliteD1, fixtureItems, storage, eventFor, episodeUuid } from "./support.mjs";

async function setup(t) {
    const db = new SqliteD1();
    t.after(() => db.close());
    const store = new D1Store(db);
    const fixture = await fixtureItems();
    const sources = { pocketCasts: async () => fixture.pocketCasts, uploads: async () => fixture.uploads };
    const input = { events: [], storage, downloads: [] };
    const sync = overrides => syncWatch({ store, watchId: "watch", sources, input, now: 200, ...overrides });
    return { db, store, ...fixture, sources, input, sync };
}

test("normal sync returns a versioned manifest without exposing account mapping", async t => {
    const { sync } = await setup(t);
    const result = await sync();
    assert.equal(result.protocol_version, 1);
    assert.equal(result.queue.items.length, 2);
    assert.equal(JSON.stringify(result).includes(episodeUuid), false);
    assert.deepEqual(result.sources, { pocketcasts_stale: false, uploads_stale: false });
});

test("completion acknowledgement and queue cleanup work while Pocket Casts is down", async t => {
    const { sync, input, sources, items } = await setup(t);
    await sync();
    const result = await sync({ sources: { ...sources, pocketCasts: async () => { throw new Error("Unavailable"); } },
        input: { ...input, events: [eventFor(items[0])], storage: { ...storage, usedBytes: 100 },
            downloads: [{ id: items[0].id, bytes: 100 }] } });
    assert.deepEqual(result.acknowledged_event_ids, ["fixture-event"]);
    assert.deepEqual(result.queue.evictIds, [items[0].id]);
    assert.deepEqual(result.queue.items.map(item => item.id), [items[1].id]);
    assert.equal(result.sources.pocketcasts_stale, true);
    assert.equal(result.pocket_casts_delivery.pending, 1);
});

test("lost sync response can be replayed without duplicate delivery", async t => {
    const { sync, input, items, db } = await setup(t);
    await sync();
    const completed = { ...input, events: [eventFor(items[0])] };
    await sync({ input: completed });
    const retried = await sync({ input: completed });
    assert.deepEqual(retried.acknowledged_event_ids, ["fixture-event"]);
    assert.equal(db.rows("pocket_casts_outbox").length, 1);
});

test("in-progress audio survives removal from both source lists", async t => {
    const { sync, input, items } = await setup(t);
    await sync();
    const result = await sync({ sources: { pocketCasts: async () => [], uploads: async () => [] },
        input: { ...input, inProgressId: items[0].id, storage: { ...storage, usedBytes: 100 },
            downloads: [{ id: items[0].id, bytes: 100 }] } });
    assert.equal(result.queue.items[0].id, items[0].id);
    assert.equal(result.queue.items[0].download, false);
});

test("a new install can use uploads while Pocket Casts is unavailable", async t => {
    const { sync, sources } = await setup(t);
    const result = await sync({ sources: { ...sources, pocketCasts: async () => { throw new Error("Auth failed"); } } });
    assert.equal(result.queue.items.length, 1);
    assert.equal(result.queue.items[0].source, "upload");
});

test("malformed source responses retain the last good snapshot", async t => {
    const { sync, sources, items } = await setup(t);
    await sync();
    const result = await sync({ sources: { ...sources, pocketCasts: async () => [{ id: "invalid" }] }, now: 300 });
    assert.equal(result.sources.pocketcasts_stale, true);
    assert.ok(result.queue.items.some(item => item.id === items[0].id));
});

test("invalid storage reports fail before accepting completion events", async t => {
    const { sync, input, items, db } = await setup(t);
    await sync();
    await assert.rejects(sync({ input: { ...input, events: [eventFor(items[0])],
        storage: { ...storage, usedBytes: -1 } } }), /invalid_storage/);
    assert.deepEqual(db.rows("watch_events"), []);
});
