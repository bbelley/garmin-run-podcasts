import { D1Store, InputError } from "../../backend-core/src/store.mjs";
import { syncWatch } from "../../backend-core/src/sync.mjs";
import { deliverOne } from "../../backend-core/src/outbox.mjs";
import { PocketCastsAdapter } from "./pocket-casts.mjs";
import { SessionStore, validateSession } from "./session.mjs";
import { loadUploads } from "./uploads.mjs";
import { enrichUpcomingSizes } from "./media-size.mjs";
import { authorized, HttpError, json, readJson } from "./http.mjs";
import { BrowserSessions } from "./browser-session.mjs";
import { connectAccount } from "./connect-account.mjs";
import { setupAsset } from "./setup-page.mjs";

export function integrate(legacy, uploadConfig, fetcher = fetch) {
    fetcher = fetcher.bind(globalThis);
    return {
        async fetch(request, env, ctx) {
            const url = new URL(request.url);
            const asset = setupAsset(request);
            if (asset) return asset;
            if (!url.pathname.startsWith("/v1/")) return legacy.fetch(request, env, ctx);
            try {
                if (url.pathname === "/v1/health" && request.method === "GET") return json({ app: "PaceJams", protocol_version: 1 });
                const browsers = new BrowserSessions(env.PACEJAMS_DB, env.PACEJAMS_ADMIN_TOKEN);
                if (url.pathname === "/v1/setup/session" && request.method === "POST") {
                    if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") throw new HttpError(415, "json_required");
                    const input = await readJson(request, 1024);
                    const session = await browsers.redeem(request, input?.code);
                    return json({ csrf_token: session.csrf_token }, 200, { "Set-Cookie": session.cookie });
                }
                const isAdmin = url.pathname.startsWith("/v1/admin/");
                const auth = isAdmin ? await browsers.authorize(request) : await authorized(request, env.PACEJAMS_WATCH_TOKEN);
                const store = new D1Store(env.PACEJAMS_DB);
                const sessions = new SessionStore(env.PACEJAMS_DB, env.POCKET_CASTS_SESSION_KEY);
                if (url.pathname === "/v1/admin/status" && request.method === "GET") {
                    const session = await sessions.get();
                    return json({ pocket_casts: !session ? "setup_required" : session.reconnectRequired ? "reconnect_required" : "connected",
                        delivery: await store.deliveryStatus(), writeback_enabled: env.POCKET_CASTS_WRITEBACK_ENABLED === "true" });
                }
                if (url.pathname === "/v1/admin/browser-session" && request.method === "GET") return json({ csrf_token: auth.csrf_token });
                if (url.pathname === "/v1/admin/browser-session" && request.method === "DELETE") {
                    return json({ signed_out: true }, 200, { "Set-Cookie": await browsers.logout(auth) });
                }
                if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
                if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") throw new HttpError(415, "json_required");
                const input = await readJson(request, url.pathname === "/v1/admin/pocket-casts/connect" ? 8192 : 65536);
                if (url.pathname === "/v1/admin/setup-links") return json(await browsers.createTicket());
                if (url.pathname === "/v1/admin/pocket-casts/connect") return json(await connectAccount(input, sessions, store, fetcher));
                if (url.pathname === "/v1/admin/pocket-casts/session") {
                    validateSession(input);
                    await sessions.connect(input);
                    await store.resumeDeliveries(Math.floor(Date.now() / 1000));
                    return json({ connected: true });
                }
                if (url.pathname === "/v1/admin/pocket-casts/check") {
                    const adapter = new PocketCastsAdapter(sessions, fetcher);
                    let stage = "refresh";
                    try {
                        await adapter.access(true);
                        stage = "playlist";
                        const items = await adapter.list();
                        return json({ connected: true, playlist_items: items.length });
                    } catch (error) {
                        const allowed = ["auth_required", "retry_required", "invalid_response", "playlist_missing", "playlist_limit", "invalid_playlist"];
                        return json({ error: "pocket_casts_check_failed", stage,
                            reason: allowed.includes(error.code) ? error.code :
                                /illegal invocation/i.test(error.message ?? "") ? "runtime_invocation" :
                                /^invalid_session/.test(error.message ?? "") ? "invalid_session" : "unexpected_response",
                            ...(Number.isInteger(error.httpStatus) ? { upstream_status: error.httpStatus } : {}) }, 503);
                    }
                }
                if (url.pathname !== "/v1/watch/sync") throw new HttpError(404, "not_found");
                if (input?.protocol_version !== 1) throw new HttpError(400, "unsupported_protocol");
                const adapter = new PocketCastsAdapter(sessions, fetcher);
                const result = await syncWatch({ store, watchId: "primary-watch", input,
                    now: Math.floor(Date.now() / 1000), sources: {
                        pocketCasts: async () => enrichUpcomingSizes(await adapter.list(), fetcher),
                        uploads: () => loadUploads(env.PODCASTS, uploadConfig, uploadConfig.publicOrigin ?? url.origin),
                    } });
                const session = await sessions.get();
                result.pocket_casts_connection = !session ? "setup_required" : session.reconnectRequired ? "reconnect_required" : "connected";
                if (env.POCKET_CASTS_WRITEBACK_ENABLED === "true") {
                    ctx.waitUntil(deliverOne(store, adapter, Math.floor(Date.now() / 1000)).catch(() => {}));
                }
                return json(result);
            } catch (error) {
                if (error instanceof HttpError) return json({ error: error.message }, error.status);
                if (error instanceof InputError || /^invalid_/.test(error.message ?? "")) return json({ error: "invalid_request" }, 400);
                if (/event_identity_conflict/.test(error.message ?? "")) return json({ error: "event_conflict" }, 409);
                return json({ error: "service_unavailable" }, 503);
            }
        },
    };
}
