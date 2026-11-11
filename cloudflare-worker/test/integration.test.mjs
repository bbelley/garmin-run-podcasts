import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { integrate } from "../src/index.mjs";
import { SessionStore } from "../src/session.mjs";
import { PocketCastsAdapter } from "../src/pocket-casts.mjs";
import { enrichUpcomingSizes } from "../src/media-size.mjs";
import { loadUploads } from "../src/uploads.mjs";
import { SqliteD1, episodeUuid, podcastUuid, storage } from "../../backend-core/test/support.mjs";

const watch = "fixture-watch-".repeat(4);
const admin = "fixture-admin-".repeat(4);
const key = btoa("0".repeat(32));
const playlistId = "00000000-0000-0000-0000-000000000005";
const jwt = expiry => "fixture." + btoa(JSON.stringify({ exp: expiry })) + ".fixture";

function setup(t) {
    const db = new SqliteD1();
    db.sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
    t.after(() => db.close());
    const env = { PACEJAMS_DB: db, PACEJAMS_WATCH_TOKEN: watch, PACEJAMS_ADMIN_TOKEN: admin,
        POCKET_CASTS_SESSION_KEY: key, POCKET_CASTS_WRITEBACK_ENABLED: "false", PODCASTS: {
            list: async () => ({ objects: [{ key: "fixture_clip.mp3", size: 80, uploaded: new Date(0),
                customMetadata: { title: "Edited fixture title", duration: "60" } }], truncated: false }),
        } };
    const config = { feedPath: "fixture-feed", episodeDetails: {}, replacements: {} };
    const legacy = { fetch: async () => new Response("Legacy feed") };
    const background = [];
    const ctx = { waitUntil: promise => background.push(promise) };
    return { db, env, config, legacy, ctx, background };
}

function post(path, body, token = watch) {
    return new Request("https://worker.example.com" + path, { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

test("legacy feed routes pass through the integration", async t => {
    const { env, config, legacy, ctx } = setup(t);
    const worker = integrate(legacy, config);
    const response = await worker.fetch(new Request("https://worker.example.com/fixture-feed/feed.xml"), env, ctx);
    assert.equal(await response.text(), "Legacy feed");
});

test("watch and admin credentials authorize distinct bounded endpoints", async t => {
    const { env, config, legacy, ctx, db } = setup(t);
    const worker = integrate(legacy, config);
    assert.equal((await worker.fetch(new Request("https://worker.example.com/v1/watch/sync"), env, ctx)).status, 401);
    assert.equal((await worker.fetch(post("/v1/admin/pocket-casts/session", {}, watch), env, ctx)).status, 401);
    assert.equal((await worker.fetch(post("/v1/watch/sync", { protocol_version: 9 }), env, ctx)).status, 400);
    const large = new Request("https://worker.example.com/v1/watch/sync", { method: "POST",
        headers: { Authorization: `Bearer ${watch}`, "Content-Type": "application/json" }, body: "x".repeat(65537) });
    assert.equal((await worker.fetch(large, env, ctx)).status, 413);
    assert.equal(db.rows("watch_events").length, 0);
});

test("a live-shaped sync serves R2 uploads while the account awaits setup", async t => {
    const { env, config, legacy, ctx, background } = setup(t);
    const worker = integrate(legacy, config);
    const response = await worker.fetch(post("/v1/watch/sync", { protocol_version: 1, events: [], downloads: [], storage }), env, ctx);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const result = await response.json();
    assert.equal(result.pocket_casts_connection, "setup_required");
    assert.equal(result.queue.items[0].title, "Edited fixture title");
    assert.equal(result.queue.items[0].size_bytes, 80);
    assert.equal(background.length, 0);
});

test("R2 upload rules retain replacements, pagination, edited titles, and opt-outs", async () => {
    const object = (key, meta = {}) => ({ key, size: 80, uploaded: new Date(0), customMetadata: meta });
    const pages = [
        { objects: [object("old.mp3"), object("skip.mp3", { addToRun: "false" })], truncated: true, cursor: "second" },
        { objects: [object("new.mp3", { title: "New title", pinned: "true" }), object("other.wav")], truncated: false },
    ];
    const result = await loadUploads({ list: async () => pages.shift() },
        { feedPath: "fixture", replacements: { "old.mp3": "new.mp3" } }, "https://worker.example.com");
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "New title");
    assert.equal(result[0].pinned, true);
});

test("session tokens are encrypted in D1 and reconnect invalidates an old refresh lease", async t => {
    const { db } = setup(t);
    const sessions = new SessionStore(db, key);
    await sessions.connect({ playlistId, accessToken: jwt(1), refreshToken: "fixture-refresh" });
    assert.equal(db.rows("pocket_casts_session")[0].encrypted_data.includes("fixture-refresh"), false);
    const first = await sessions.get();
    const lease = await sessions.claim(first.version, 100);
    assert.ok(lease);
    assert.equal(await sessions.claim(first.version, 101), null);
    await sessions.connect({ playlistId, accessToken: jwt(10000), refreshToken: "replacement-refresh" });
    await assert.rejects(sessions.saveRefresh(first.data, first.version, lease), /retry_required/);
    assert.equal((await sessions.get()).data.refreshToken, "replacement-refresh");
    await assert.rejects(new SessionStore(db, btoa("1".repeat(32))).get());
});

test("expired access refreshes once and saves a rotated refresh token", async t => {
    const { db } = setup(t);
    const sessions = new SessionStore(db, key);
    await sessions.connect({ playlistId, accessToken: jwt(1), refreshToken: "fixture-refresh" });
    const calls = [];
    const fetcher = async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/user/token")) return Response.json({ accessToken: jwt(10000), refreshToken: "rotated-refresh" });
        return Response.json({ playlists: [{ uuid: playlistId, manual: true, episodeOrder: [], episodes: [] }] });
    };
    const adapter = new PocketCastsAdapter(sessions, fetcher, () => 100);
    assert.deepEqual(await adapter.list(), []);
    assert.equal(calls.filter(call => call.url.endsWith("/user/token")).length, 1);
    assert.equal((await sessions.get()).data.refreshToken, "rotated-refresh");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.headers.Authorization, undefined);
});

test("a rejected refresh records reconnect status without leaking response details", async t => {
    const { db } = setup(t);
    const sessions = new SessionStore(db, key);
    await sessions.connect({ playlistId, accessToken: jwt(1), refreshToken: "fixture-refresh" });
    const adapter = new PocketCastsAdapter(sessions, async () => new Response("private error detail", { status: 401 }), () => 100);
    await assert.rejects(adapter.list(), /auth_required/);
    assert.equal((await sessions.get()).reconnectRequired, true);
});

test("media size discovery accepts byte ranges and sends no account credential", async () => {
    const result = await enrichUpcomingSizes([{ played: false, audioUrl: "https://audio.example.com/clip.mp3", sizeBytes: null }], async (_, options) => {
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.headers.Range, "bytes=0-9");
        return new Response(new Uint8Array([1]), { status: 206,
            headers: { "Content-Type": "audio/mpeg", "Content-Range": "bytes 0-0/1234" } });
    });
    assert.equal(result[0].sizeBytes, 1234);
    const unsafe = await enrichUpcomingSizes([{ played: false, audioUrl: "https://127.0.0.1/clip.mp3", sizeBytes: null }],
        async () => assert.fail("Unsafe host was fetched"));
    assert.equal(unsafe[0].sizeBytes, null);
});

test("completion writes contain only the verified status fields", async t => {
    const { db } = setup(t);
    const sessions = new SessionStore(db, key);
    await sessions.connect({ playlistId, accessToken: jwt(10000), refreshToken: "fixture-refresh" });
    const adapter = new PocketCastsAdapter(sessions, async (url, options) => {
        assert.ok(url.endsWith("/sync/update_episode"));
        assert.deepEqual(JSON.parse(options.body), { uuid: episodeUuid, podcast: podcastUuid, status: 3 });
        return Response.json({});
    }, () => 100);
    await adapter.markPlayed(episodeUuid, podcastUuid);
});

test("the private account check renews in the Worker and reads the selected playlist", async t => {
    const { env, config, legacy, ctx, db } = setup(t);
    const sessions = new SessionStore(db, key);
    await sessions.connect({ playlistId, accessToken: jwt(1), refreshToken: "fixture-refresh" });
    let refreshed = 0;
    const worker = integrate(legacy, config, async url => {
        if (url.endsWith("/user/token")) {
            refreshed += 1;
            return Response.json({ accessToken: jwt(4000000000), refreshToken: "rotated-refresh" });
        }
        assert.ok(url.endsWith("/user/playlists"));
        return Response.json({ playlists: [{ uuid: playlistId, manual: true, episodeOrder: [], episodes: [] }] });
    });
    const response = await worker.fetch(post("/v1/admin/pocket-casts/check", {}, admin), env, ctx);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { connected: true, playlist_items: 0 });
    assert.equal(refreshed, 1);
    assert.equal((await sessions.get()).data.refreshToken, "rotated-refresh");
    assert.equal((await worker.fetch(post("/v1/admin/pocket-casts/check", {}, watch), env, ctx)).status, 401);
});

test("the live account API episode field is adapted before queue normalization", async t => {
    const { db } = setup(t);
    const sessions = new SessionStore(db, key);
    await sessions.connect({ playlistId, accessToken: jwt(10000), refreshToken: "fixture-refresh" });
    const adapter = new PocketCastsAdapter(sessions, async url => {
        if (url.endsWith("/user/playlists")) return Response.json({ playlists: [{ uuid: playlistId, manual: true,
            episodeOrder: [episodeUuid], episodes: [{ episode: episodeUuid, podcast: podcastUuid }] }] });
        return Response.json({ uuid: episodeUuid, podcastUuid, title: "Fixture", duration: 60,
            playingStatus: 1, url: "https://audio.example.com/fixture.mp3" });
    }, () => 100);
    assert.equal((await adapter.list())[0].pocketCasts.episodeUuid, episodeUuid);
});

test("the account check reports only a safe stage and upstream status", async t => {
    const { env, config, legacy, ctx, db } = setup(t);
    await new SessionStore(db, key).connect({ playlistId, accessToken: jwt(1), refreshToken: "fixture-refresh" });
    const worker = integrate(legacy, config, async () => new Response("private account details", { status: 500 }));
    const response = await worker.fetch(post("/v1/admin/pocket-casts/check", {}, admin), env, ctx);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "pocket_casts_check_failed", stage: "refresh",
        reason: "retry_required", upstream_status: 500 });
});

test("binary media types need an MP3 prefix before their size is accepted", async () => {
    const items = [{ played: false, audioUrl: "https://audio.example.com/clip.mp3", sizeBytes: null }];
    for (const type of ["binary/octet-stream", "application/octet-stream"]) {
        const mp3 = await enrichUpcomingSizes(items, async () => new Response(
            new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), { status: 206,
                headers: { "Content-Type": type, "Content-Range": "bytes 0-9/1234" } }));
        assert.equal(mp3[0].sizeBytes, 1234);
        const other = await enrichUpcomingSizes(items, async () => new Response("not an mp3", { status: 206,
            headers: { "Content-Type": type, "Content-Range": "bytes 0-9/1234" } }));
        assert.equal(other[0].sizeBytes, null);
    }
});

test("stored native fetch functions retain the runtime receiver", async t => {
    const { db } = setup(t);
    const sessions = new SessionStore(db, key);
    await sessions.connect({ playlistId, accessToken: jwt(10000), refreshToken: "fixture-refresh" });
    const adapter = new PocketCastsAdapter(sessions, function () {
        assert.equal(this, globalThis);
        return Promise.resolve(Response.json({ playlists: [{ uuid: playlistId, manual: true, episodeOrder: [], episodes: [] }] }));
    }, () => 100);
    assert.deepEqual(await adapter.list(), []);
    const items = [{ played: false, audioUrl: "https://audio.example.com/clip.mp3", sizeBytes: null }];
    const sized = await enrichUpcomingSizes(items, function () {
        assert.equal(this, globalThis);
        return Promise.resolve(new Response(new Uint8Array([1]), { status: 206,
            headers: { "Content-Type": "audio/mpeg", "Content-Range": "bytes 0-0/1234" } }));
    });
    assert.equal(sized[0].sizeBytes, 1234);
});
