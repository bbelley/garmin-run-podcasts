import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { D1Store, validateEvents } from "../src/store.mjs";
import { normalizeUploads } from "../src/queue.mjs";
import { SqliteD1, fixtureItems, eventFor, episodeUuid, podcastUuid } from "./support.mjs";

async function setup(t) {
    const db = new SqliteD1();
    t.after(() => db.close());
    const store = new D1Store(db);
    const fixture = await fixtureItems();
    await store.saveCatalog(fixture.items);
    return { db, store, ...fixture };
}

test("events, completions, and matched outbox work commit before acknowledgement", async t => {
    const { db, store, items } = await setup(t);
    assert.deepEqual(await store.recordCompletions("fixture-watch", [eventFor(items[0])], 200), ["fixture-event"]);
    assert.equal(db.rows("watch_events").length, 1);
    assert.equal(db.rows("completions").length, 1);
    assert.equal(db.rows("pocket_casts_outbox").length, 1);
    assert.deepEqual(await store.completedIds(), [items[0].id]);
});

test("replayed events and multiple completions of one episode create one delivery", async t => {
    const { db, store, items } = await setup(t);
    const event = eventFor(items[0]);
    await store.recordCompletions("watch", [event, event], 200);
    await store.recordCompletions("watch", [event, eventFor(items[0], "another-event")], 300);
    assert.equal(db.rows("watch_events").length, 2);
    assert.equal(db.rows("completions").length, 1);
    assert.equal(db.rows("pocket_casts_outbox").length, 1);
});

test("a reused event ID with changed content rolls back the whole incoming batch", async t => {
    const { db, store, items } = await setup(t);
    await store.recordCompletions("watch", [eventFor(items[0])], 200);
    await assert.rejects(store.recordCompletions("watch", [eventFor(items[1], "new-event"),
        eventFor(items[1])], 300), /event_identity_conflict/);
    assert.equal(db.rows("watch_events").length, 1);
    assert.equal(db.rows("completions").length, 1);
});

test("a replay from another watch cannot claim the same event identity", async t => {
    const { store, items } = await setup(t);
    await store.recordCompletions("first-watch", [eventFor(items[0])], 200);
    await assert.rejects(store.recordCompletions("second-watch", [eventFor(items[0])], 300), /event_identity_conflict/);
});

test("concurrent duplicate submissions persist one completion and delivery", async t => {
    const { store, db, items } = await setup(t);
    const event = eventFor(items[0]);
    const responses = await Promise.all([
        store.recordCompletions("watch", [event], 200), store.recordCompletions("watch", [event], 201),
    ]);
    assert.deepEqual(responses, [["fixture-event"], ["fixture-event"]]);
    assert.equal(db.rows("watch_events").length, 1);
    assert.equal(db.rows("completions").length, 1);
    assert.equal(db.rows("pocket_casts_outbox").length, 1);
});

test("storage failure and unknown item references acknowledge nothing and roll back", async t => {
    const { db, store, items } = await setup(t);
    db.failSql = sql => sql.includes("INSERT INTO pocket_casts_outbox");
    await assert.rejects(store.recordCompletions("watch", [eventFor(items[0])], 200), /injected_storage_failure/);
    assert.deepEqual(db.rows("watch_events"), []);
    assert.deepEqual(db.rows("completions"), []);
    db.failSql = null;
    const missing = { ...eventFor(items[0]), item_id: "pj_" + "0".repeat(64) };
    await assert.rejects(store.recordCompletions("watch", [missing], 200), /FOREIGN KEY/);
    assert.deepEqual(db.rows("watch_events"), []);
});

test("personal uploads complete locally and acquire delivery only after an explicit verified match", async t => {
    const { db, store, uploads } = await setup(t);
    await store.recordCompletions("watch", [eventFor(uploads[0])], 200);
    assert.equal(db.rows("completions").length, 1);
    assert.deepEqual(db.rows("pocket_casts_outbox"), []);
    const matched = await normalizeUploads("fixture-feed", [{ guid: "upload-one", title: "Personal clip",
        enclosureUrl: "https://audio.example.com/upload.mp3", enclosureBytes: 80,
        pocketCastsMatch: { verified: true, episodeUuid, podcastUuid } }]);
    await store.saveCatalog(matched);
    assert.equal(db.rows("pocket_casts_outbox").length, 1);
    assert.equal(db.rows("pocket_casts_outbox")[0].item_id, matched[0].id);
    assert.deepEqual(new Set(await store.completedIds()), new Set(matched[0].aliases));
});

test("verified mappings cannot be silently retargeted", async t => {
    const { store, items } = await setup(t);
    const changed = { ...items[0], pocketCasts: { ...items[0].pocketCasts,
        podcastUuid: "00000000-0000-0000-0000-000000000004" } };
    await assert.rejects(store.saveCatalog([changed]), /catalog_mapping_conflict/);
    assert.equal((await store.item(items[0].id)).pocketCasts.podcastUuid, podcastUuid);
});

test("event payload accepts only explicit natural-end or Mark Finished records", async () => {
    const { items } = await fixtureItems();
    for (const reason of ["pause", "skip", "delete", undefined]) {
        assert.throws(() => validateEvents([{ ...eventFor(items[0]), reason }]), /invalid_event/);
    }
    assert.throws(() => validateEvents(Array(33).fill(eventFor(items[0]))), /invalid_events/);
    assert.throws(() => validateEvents([{ ...eventFor(items[0]), event_id: undefined }]), /invalid_event/);
    assert.throws(() => validateEvents([eventFor(items[0]), { ...eventFor(items[0]), occurred_at: 101 }]), /event_identity_conflict/);
});

test("acknowledged completion survives database close and reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pacejams-test-"));
    const file = join(dir, "state.sqlite");
    let db = new SqliteD1(file);
    try {
        const { items } = await fixtureItems();
        let store = new D1Store(db);
        await store.saveCatalog(items);
        await store.recordCompletions("watch", [eventFor(items[0])], 200);
        db.close();
        db = new SqliteD1(file);
        store = new D1Store(db);
        assert.deepEqual(await store.completedIds(), [items[0].id]);
        assert.deepEqual(await store.recordCompletions("watch", [eventFor(items[0])], 300), ["fixture-event"]);
        assert.equal(db.rows("pocket_casts_outbox").length, 1);
    } finally {
        db.close();
        unlinkSync(file);
        rmdirSync(dir);
    }
});

test("an older source refresh cannot overwrite the newer snapshot", async t => {
    const { store, items } = await setup(t);
    await store.saveSnapshot("uploads", [items[1]], 300);
    await store.saveSnapshot("uploads", [], 200);
    assert.equal((await store.snapshot("uploads")).items.length, 1);
});
