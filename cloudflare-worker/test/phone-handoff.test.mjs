import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import jsQR from "jsqr";
import { GifReader } from "omggif";
import { integrate } from "../src/index.mjs";
import { BrowserSessions } from "../src/browser-session.mjs";
import { phoneHandoff } from "../src/phone-handoff.mjs";
import { qrScriptSource } from "../qr-assets.mjs";
import { SqliteD1 } from "../../backend-core/test/support.mjs";

const origin = "https://worker.example.com";
const canonical = "https://canonical.example.com";
const watch = "fixture-watch-".repeat(4);
const admin = "fixture-admin-".repeat(4);

function setup(t) {
    const db = new SqliteD1();
    db.sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
    t.after(() => db.close());
    const worker = integrate({ fetch: async () => new Response("Legacy") }, { publicOrigin: canonical, qrScript: qrScriptSource() },
        async () => assert.fail("Phone handoff must not contact Pocket Casts"));
    const env = { PACEJAMS_DB: db, PACEJAMS_ADMIN_TOKEN: admin, PACEJAMS_WATCH_TOKEN: watch };
    return { db, fetch: request => worker.fetch(request, env, { waitUntil: () => assert.fail("No delivery should run") }) };
}

function post(path, body, { bearer = admin, cookie, csrf, from } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers["X-PaceJams-CSRF"] = csrf;
    if (from) headers.Origin = from;
    return new Request(origin + path, { method: "POST", headers, body: JSON.stringify(body) });
}

test("phone handoff uses the canonical origin and its exact QR image independently decodes", async t => {
    const { fetch, db } = setup(t);
    const response = await fetch(post("/v1/admin/setup-links", { phone_handoff: true }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const result = await response.json();
    const link = new URL(result.setup_url);
    assert.equal(link.origin, canonical);
    assert.equal(link.pathname, "/setup");
    assert.equal(link.search, "");
    assert.equal(new URLSearchParams(link.hash.slice(1)).get("code"), result.code);
    assert.equal(result.expires_in, 300);
    assert.ok(!result.setup_url.includes(admin) && !result.setup_url.includes(watch));
    assert.ok(!JSON.stringify(db.rows("setup_tickets")).includes(result.code));

    // Run the same script served to the browser, then decode its actual GIF with
    // independent GIF and QR readers rather than trusting the encoder's matrix.
    const asset = await fetch(new Request(origin + "/setup/qr.js"));
    assert.equal(asset.status, 200);
    const context = createContext({});
    new Script(await asset.text()).runInContext(context);
    const qr = context.qrcode(0, "M"); qr.addData(result.setup_url, "Byte"); qr.make();
    const image = qr.createDataURL(5, 20);
    assert.ok(image.startsWith("data:image/gif;base64,"));
    const gif = new GifReader(Buffer.from(image.split(",")[1], "base64"));
    const pixels = new Uint8ClampedArray(gif.width * gif.height * 4);
    gif.decodeAndBlitFrameRGBA(0, pixels);
    const decoded = jsQR(pixels, gif.width, gif.height, { inversionAttempts: "dontInvert" });
    assert.equal(decoded?.data, result.setup_url);
});

test("the terminal setup-link response remains unchanged without a handoff request", async t => {
    const { fetch } = setup(t);
    const result = await (await fetch(post("/v1/admin/setup-links", {}))).json();
    assert.deepEqual(Object.keys(result).sort(), ["code", "expires_in"]);
});

test("watch and unauthenticated requests cannot mint or revoke phone setup access", async t => {
    const { fetch, db } = setup(t);
    for (const path of ["/v1/admin/setup-links", "/v1/admin/setup-links/revoke"]) {
        for (const bearer of [watch, null]) {
            assert.equal((await fetch(post(path, { phone_handoff: true }, { bearer }))).status, 401);
        }
    }
    assert.equal(db.rows("setup_tickets").length, 0);
});

test("closing an unused code revokes it but never signs out a phone that already redeemed it", async t => {
    const { db } = setup(t);
    const sessions = new BrowserSessions(db, admin, () => 100);
    const unused = await phoneHandoff(sessions, origin);
    assert.deepEqual(await sessions.revokeTicket(unused.code), { revoked: true });
    const redeem = post("/v1/setup/session", {}, { bearer: null, from: origin });
    await assert.rejects(sessions.redeem(redeem, unused.code), /setup_link_invalid/);
    const opened = await phoneHandoff(sessions, origin);
    const phone = await sessions.redeem(redeem, opened.code);
    assert.deepEqual(await sessions.revokeTicket(opened.code), { revoked: false });
    const request = new Request(origin + "/v1/admin/status", { headers: { Cookie: phone.cookie.split(";")[0] } });
    assert.equal((await sessions.authorize(request)).browser, true);
    await assert.rejects(sessions.redeem(redeem, opened.code), /setup_link_invalid/);
});

test("browser cancellation requires its own origin and CSRF value", async t => {
    const { fetch, db } = setup(t);
    const initial = await (await fetch(post("/v1/admin/setup-links", {}))).json();
    const redeemed = await fetch(post("/v1/setup/session", { code: initial.code }, { bearer: null, from: origin }));
    const cookie = redeemed.headers.get("Set-Cookie").split(";")[0];
    const csrf = (await redeemed.json()).csrf_token;
    const ticket = await (await fetch(post("/v1/admin/setup-links", { phone_handoff: true }, { bearer: null, cookie, csrf, from: origin }))).json();
    assert.equal((await fetch(post("/v1/admin/setup-links/revoke", { code: ticket.code }, { bearer: null, cookie, from: origin }))).status, 403);
    assert.equal((await fetch(post("/v1/admin/setup-links/revoke", { code: ticket.code }, { bearer: null, cookie, csrf, from: "https://other.example.com" }))).status, 403);
    assert.equal(db.rows("setup_tickets").length, 1);
    const closed = await fetch(post("/v1/admin/setup-links/revoke", { code: ticket.code }, { bearer: null, cookie, csrf, from: origin }));
    assert.deepEqual(await closed.json(), { revoked: true });
    assert.equal(db.rows("setup_tickets").length, 0);
});

test("invalid setup origins are rejected before a credential is created", async t => {
    const { db } = setup(t);
    const sessions = new BrowserSessions(db, admin);
    for (const value of ["http://worker.example.com", origin + "/unexpected", origin + "?extra=1", origin + "#fragment"]) {
        await assert.rejects(phoneHandoff(sessions, value), /setup_origin_invalid/);
    }
    assert.equal(db.rows("setup_tickets").length, 0);
});

test("desktop logout leaves the redeemed phone session independent", async t => {
    const { fetch } = setup(t);
    const initial = await (await fetch(post("/v1/admin/setup-links", {}))).json();
    const desktop = await fetch(post("/v1/setup/session", { code: initial.code }, { bearer: null, from: origin }));
    const cookie = desktop.headers.get("Set-Cookie").split(";")[0];
    const csrf = (await desktop.json()).csrf_token;
    const ticket = await (await fetch(post("/v1/admin/setup-links", { phone_handoff: true }, { bearer: null, cookie, csrf, from: origin }))).json();
    const phone = await fetch(post("/v1/setup/session", { code: ticket.code }, { bearer: null, from: origin }));
    const phoneCookie = phone.headers.get("Set-Cookie").split(";")[0];
    const phoneCsrf = (await phone.json()).csrf_token;
    assert.notEqual(phoneCookie, cookie);
    const logout = (sessionCookie, token) => fetch(new Request(origin + "/v1/admin/browser-session", {
        method: "DELETE", headers: { Cookie: sessionCookie, Origin: origin, "X-PaceJams-CSRF": token },
    }));
    assert.equal((await logout(cookie, csrf)).status, 200);
    const session = sessionCookie => fetch(new Request(origin + "/v1/admin/browser-session", { headers: { Cookie: sessionCookie } }));
    assert.equal((await session(cookie)).status, 401);
    assert.equal((await session(phoneCookie)).status, 200);
    assert.equal((await logout(phoneCookie, phoneCsrf)).status, 200);
    assert.equal((await session(phoneCookie)).status, 401);
});
