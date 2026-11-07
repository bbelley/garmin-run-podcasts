import { PocketCastsAdapter } from "./pocket-casts.mjs";
import { PocketCastsError } from "../../backend-core/src/outbox.mjs";
import { HttpError } from "./http.mjs";
import { validateSession } from "./session.mjs";

function playlist(result, predicate) {
    if (!Array.isArray(result.playlists)) throw new PocketCastsError("invalid_response");
    const matches = result.playlists.filter(item => item?.manual && !item.isDeleted && predicate(item));
    if (matches.length !== 1) throw new HttpError(400, matches.length ? "playlist_ambiguous" : "playlist_missing");
    const selected = matches[0];
    if (!Array.isArray(selected.episodeOrder) || !Array.isArray(selected.episodes)) throw new PocketCastsError("invalid_response");
    if (selected.episodeOrder.length > 32) throw new HttpError(400, "playlist_limit");
    return selected;
}

export async function connectAccount(input, sessions, store, fetcher = fetch) {
    if (!input || typeof input.email !== "string" || input.email.trim().length > 320 ||
        !/^[^\s@]+@[^\s@]+$/.test(input.email.trim()) || typeof input.password !== "string" ||
        !input.password || input.password.length > 1024 || typeof input.playlist_name !== "string" ||
        !input.playlist_name.trim() || input.playlist_name.trim().length > 256) throw new HttpError(400, "account_fields_required");
    const adapter = new PocketCastsAdapter(sessions, fetcher);
    try {
        const login = await adapter.exchange("/user/login_pocket_casts", {
            email: input.email.trim(), password: input.password, scope: "webplayer",
        });
        // Neither password nor email is included in the persisted session.
        input.password = "";
        const initial = validateSession({ accessToken: login.accessToken ?? login.access_token,
            refreshToken: login.refreshToken ?? login.refresh_token,
            playlistId: "00000000-0000-0000-0000-000000000000" });
        const selected = playlist(await adapter.exchange("/user/playlists", undefined, initial.accessToken),
            item => item.title === input.playlist_name.trim());
        const renewal = await adapter.exchange("/user/token", { grant_type: "refresh_token",
            refresh_token: initial.refreshToken, scope: "webplayer" });
        const data = validateSession({ playlistId: selected.uuid, accessToken: renewal.accessToken ?? renewal.access_token,
            refreshToken: renewal.refreshToken ?? renewal.refresh_token ?? initial.refreshToken });
        const verified = playlist(await adapter.exchange("/user/playlists", undefined, data.accessToken), item => item.uuid === data.playlistId);
        await sessions.connect(data);
        await store.resumeDeliveries(Math.floor(Date.now() / 1000));
        return { connected: true, playlist_items: verified.episodeOrder.length };
    } catch (error) {
        if (error instanceof PocketCastsError && error.code === "auth_required") throw new HttpError(401, "account_sign_in_rejected");
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, "account_connection_failed");
    } finally {
        input.password = "";
    }
}
