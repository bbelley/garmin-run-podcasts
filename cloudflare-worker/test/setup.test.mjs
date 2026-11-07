import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { integrate } from "../src/index.mjs";
import { BrowserSessions } from "../src/browser-session.mjs";
import { SessionStore } from "../src/session.mjs";
import { SqliteD1 } from "../../backend-core/test/support.mjs";

const origin = "https://worker.example.com";
const watch = "fixture-watch-".repeat(4);
const admin = "fixture-admin-".repeat(4);
const key = btoa("0".repeat(32));
const playlistId = "00000000-0000-0000-0000-000000000005";
const jwt = expiry => "fixture." + btoa(JSON.stringify({ exp: expiry })) + ".fixture";
const fixturePassword = ["fixture", "password"].join("-");
const fields = () => ({ email: "reader@example.com", password: fixturePassword, playlist_name: "Run" });

function setup(t, fetcher = async () => assert.fail("Unexpected account request")) {
    const db = new SqliteD1();
    db.sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
    t.after(() => db.close());
    const env = { PACEJAMS_DB: db, PACEJAMS_ADMIN_TOKEN: admin, PACEJAMS_WATCH_TOKEN: watch,
        POCKET_CASTS_SESSION_KEY: key, POCKET_CASTS_WRITEBACK_ENABLED: "false" };
    const worker = integrate({ fetch: async () => new Response("Legacy") }, {}, fetcher);
    const fetch = request => worker.fetch(request, env, { waitUntil: () => assert.fail("Account setup scheduled a delivery") });
    return { db, env, fetch, sessions: new SessionStore(db, key) };
}

function request(path, { method = "GET", body, bearer, cookie, csrf, from } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers["X-PaceJams-CSRF"] = csrf;
    if (from) headers.Origin = from;
    return new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function browser(fetch) {
    const ticket = await (await fetch(request("/v1/admin/setup-links", { method: "POST", body: {}, bearer: admin }))).json();
    const response = await fetch(request("/v1/setup/session", { method: "POST", body: { code: ticket.code }, from: origin }));
    assert.equal(response.status, 200);
    return { code: ticket.code, cookie: response.headers.get("Set-Cookie").split(";")[0],
        csrf: (await response.json()).csrf_token, header: response.headers.get("Set-Cookie") };
}

test("setup assets have a closed content policy and contain no account credentials", async t => {
    const { fetch } = setup(t);
    for (const path of ["/setup", "/setup/style.css", "/setup/app.js"]) {
        const response = await fetch(request(path));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("Cache-Control"), "no-store");
        assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
        assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
        const body = await response.text();
        assert.ok(!body.includes(admin) && !body.includes(watch));
        assert.ok(!body.includes("localStorage") && !body.includes("sessionStorage"));
        if (path.endsWith("app.js")) new Script(body);
    }
    assert.equal((await fetch(request("/setup", { method: "POST", body: {} }))).status, 405);
    assert.equal(await (await fetch(request("/fixture/feed.xml"))).text(), "Legacy");
});

test("a setup ticket is stored as a hash and only one concurrent exchange succeeds", async t => {
    const { db } = setup(t);
    const sessions = new BrowserSessions(db, admin, () => 100);
    const ticket = await sessions.createTicket();
    assert.ok(!JSON.stringify(db.rows("setup_tickets")).includes(ticket.code));
    const req = request("/v1/setup/session", { method: "POST", from: origin });
    const results = await Promise.allSettled([sessions.redeem(req, ticket.code), sessions.redeem(req, ticket.code)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(db.rows("setup_tickets").length, 0);
    assert.equal(db.rows("browser_sessions").length, 1);
});

test("forged tickets and cookies are rejected before any database lookup", async t => {
    const { db } = setup(t);
    const sessions = new BrowserSessions(db, admin, () => 100);
    const ticket = await sessions.createTicket();
    const code = ticket.code.slice(0, -1) + (ticket.code.endsWith("a") ? "b" : "a");
    let lookups = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = (...args) => { lookups += 1; return prepare(...args); };
    await assert.rejects(sessions.redeem(request("/v1/setup/session", { method: "POST", from: origin }), code), /setup_link_invalid/);
    await assert.rejects(sessions.authorize(request("/v1/admin/status", { cookie: "__Host-pacejams_setup=" + code })), /unauthorized/);
    assert.equal(lookups, 0);
});

test("expired tickets, browser expiry, and admin rotation invalidate setup access", async t => {
    const { db } = setup(t);
    let now = 100;
    const sessions = new BrowserSessions(db, admin, () => now);
    const expired = await sessions.createTicket();
    now = 400;
    const req = request("/v1/setup/session", { method: "POST", from: origin });
    await assert.rejects(sessions.redeem(req, expired.code), /setup_link_invalid/);
    const ticket = await sessions.createTicket();
    const access = await sessions.redeem(req, ticket.code);
    const authenticated = request("/v1/admin/status", { cookie: access.cookie.split(";")[0] });
    assert.equal((await sessions.authorize(authenticated)).browser, true);
    await assert.rejects(new BrowserSessions(db, "replacement-admin-".repeat(4), () => now).authorize(authenticated), /unauthorized/);
    now += 3600;
    await assert.rejects(sessions.authorize(authenticated), /unauthorized/);
});

test("browser sessions use protected cookies and require both origin and CSRF for mutations", async t => {
    const { fetch } = setup(t);
    const access = await browser(fetch);
    for (const flag of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=3600"]) assert.ok(access.header.includes(flag));
    assert.ok(!access.header.includes("Domain="));
    const session = await fetch(request("/v1/admin/browser-session", { cookie: access.cookie }));
    assert.deepEqual(await session.json(), { csrf_token: access.csrf });
    for (const options of [{}, { csrf: access.csrf }, { from: origin }, { csrf: access.csrf, from: "https://other.example.com" }]) {
        const response = await fetch(request("/v1/admin/pocket-casts/check", { method: "POST", body: {}, cookie: access.cookie, ...options }));
        assert.equal(response.status, 403);
    }
    assert.equal((await fetch(request("/v1/admin/setup-links", { method: "POST", body: {}, bearer: watch }))).status, 401);
    assert.equal((await fetch(request("/v1/watch/sync", { method: "POST", body: {}, cookie: access.cookie }))).status, 401);
});

test("a setup link cannot be exchanged by another origin", async t => {
    const { fetch, db } = setup(t);
    const ticket = await (await fetch(request("/v1/admin/setup-links", { method: "POST", body: {}, bearer: admin }))).json();
    const response = await fetch(request("/v1/setup/session", { method: "POST", body: { code: ticket.code }, from: "https://other.example.com" }));
    assert.equal(response.status, 403);
    assert.equal(db.rows("setup_tickets").length, 1);
});

test("production setup pages and admin authentication require HTTPS", async t => {
    const { fetch, db } = setup(t);
    const page = await fetch(new Request("http://worker.example.com/setup"));
    assert.equal(page.status, 308);
    assert.equal(page.headers.get("Location"), origin + "/setup");
    const response = await fetch(new Request("http://worker.example.com/v1/admin/status", { headers: { Authorization: `Bearer ${admin}` } }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "https_required" });
    assert.equal(db.rows("browser_sessions").length, 0);
});

test("logout revokes browser access while retaining the Pocket Casts session", async t => {
    const { fetch, sessions, db } = setup(t);
    await sessions.connect({ playlistId, accessToken: jwt(4000000000), refreshToken: "fixture-refresh" });
    const access = await browser(fetch);
    const response = await fetch(request("/v1/admin/browser-session", { method: "DELETE", cookie: access.cookie, csrf: access.csrf, from: origin }));
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("Set-Cookie").includes("Max-Age=0"));
    assert.equal((await fetch(request("/v1/admin/status", { cookie: access.cookie }))).status, 401);
    assert.equal(db.rows("browser_sessions").length, 0);
    assert.equal((await sessions.get()).data.refreshToken, "fixture-refresh");
});

test("rejected sign-in preserves the existing encrypted session and returns no credentials", async t => {
    const { fetch, sessions } = setup(t, async () => new Response("private account response", { status: 401 }));
    await sessions.connect({ playlistId, accessToken: jwt(4000000000), refreshToken: "existing-refresh" });
    const before = await sessions.get();
    const access = await browser(fetch);
    const response = await fetch(request("/v1/admin/pocket-casts/connect", { method: "POST", body: fields(),
        cookie: access.cookie, csrf: access.csrf, from: origin }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "account_sign_in_rejected" });
    assert.deepEqual(await sessions.get(), before);
});

test("a missing playlist leaves the stored connection untouched", async t => {
    const { fetch, sessions } = setup(t, async url => url.endsWith("/user/login_pocket_casts") ?
        Response.json({ accessToken: jwt(4000000000), refreshToken: "new-refresh" }) : Response.json({ playlists: [] }));
    await sessions.connect({ playlistId, accessToken: jwt(4000000000), refreshToken: "existing-refresh" });
    const before = await sessions.get();
    const response = await fetch(request("/v1/admin/pocket-casts/connect", { method: "POST", body: fields(), bearer: admin }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "playlist_missing" });
    assert.deepEqual(await sessions.get(), before);
});

test("browser connection verifies renewal and encrypts tokens without storing email or password", async t => {
    const calls = [];
    const { fetch, sessions, db } = setup(t, async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/user/login_pocket_casts")) {
            assert.equal(JSON.parse(options.body).password, fixturePassword);
            return Response.json({ accessToken: jwt(4000000000), refreshToken: "initial-refresh" });
        }
        if (url.endsWith("/user/token")) return Response.json({ accessToken: jwt(4000000010), refreshToken: "rotated-refresh" });
        assert.ok(url.endsWith("/user/playlists"));
        return Response.json({ playlists: [{ uuid: playlistId, title: "Run", manual: true, episodeOrder: [], episodes: [] }] });
    });
    const access = await browser(fetch);
    const response = await fetch(request("/v1/admin/pocket-casts/connect", { method: "POST", body: fields(),
        cookie: access.cookie, csrf: access.csrf, from: origin }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { connected: true, playlist_items: 0 });
    assert.equal((await sessions.get()).data.refreshToken, "rotated-refresh");
    const stored = JSON.stringify(db.rows("pocket_casts_session"));
    for (const clear of [fixturePassword, "reader@example.com", "rotated-refresh", jwt(4000000010)]) assert.ok(!stored.includes(clear));
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => call.options.redirect === "manual" && !call.url.endsWith("/sync/update_episode")));
    const status = await (await fetch(request("/v1/admin/status", { cookie: access.cookie }))).json();
    assert.equal(status.pocket_casts, "connected");
    assert.equal(status.writeback_enabled, false);
});

test("account fields and body size are bounded before contacting Pocket Casts", async t => {
    const { fetch, db } = setup(t);
    for (const body of [{}, { ...fields(), email: "invalid" }, { ...fields(), playlist_name: "" }, { ...fields(), password: "x".repeat(1025) }]) {
        assert.equal((await fetch(request("/v1/admin/pocket-casts/connect", { method: "POST", body, bearer: admin }))).status, 400);
    }
    assert.equal((await fetch(request("/v1/admin/pocket-casts/connect", { method: "POST", body: { extra: "x".repeat(8192) }, bearer: admin }))).status, 413);
    assert.equal(db.rows("pocket_casts_session").length, 0);
});
