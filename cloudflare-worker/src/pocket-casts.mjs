import { normalizePocketCasts } from "../../backend-core/src/queue.mjs";
import { PocketCastsError } from "../../backend-core/src/outbox.mjs";
import { readJson } from "./http.mjs";

const API = "https://api.pocketcasts.com";

export class PocketCastsAdapter {
    constructor(sessions, fetcher = fetch, clock = () => Math.floor(Date.now() / 1000)) {
        this.sessions = sessions;
        // Workerd's native fetch requires its global receiver when stored on an object.
        this.fetcher = fetcher.bind(globalThis);
        this.clock = clock;
    }

    async exchange(path, body, token) {
        const headers = { Accept: "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const response = await this.fetcher(API + path, { method: body === undefined ? "GET" : "POST", headers,
            body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(10000) });
        if (response.status === 401 || response.status === 403) throw new PocketCastsError("auth_required");
        if (!response.ok) {
            const retry = Number(response.headers.get("Retry-After"));
            const error = new PocketCastsError("retry_required", Number.isFinite(retry) ? Math.max(0, retry) : 0);
            error.httpStatus = response.status;
            throw error;
        }
        const data = await readJson(response, 2097152);
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new PocketCastsError("invalid_response");
        return data;
    }

    async access(force = false) {
        const current = await this.sessions.get();
        if (!current || current.reconnectRequired) throw new PocketCastsError("auth_required");
        if (!force && current.data.expiresAt > this.clock() + 60) return current.data;
        const lease = await this.sessions.claim(current.version, this.clock());
        if (!lease) throw new PocketCastsError("retry_required", 2);
        try {
            const response = await this.exchange("/user/token", { grant_type: "refresh_token",
                refresh_token: current.data.refreshToken, scope: "webplayer" });
            const data = { ...current.data, accessToken: response.accessToken ?? response.access_token,
                refreshToken: response.refreshToken ?? response.refresh_token ?? current.data.refreshToken };
            await this.sessions.saveRefresh(data, current.version, lease);
            return (await this.sessions.get()).data;
        } catch (error) {
            await this.sessions.release(current.version, lease, error instanceof PocketCastsError && error.code === "auth_required");
            throw error;
        }
    }

    async request(path, body) {
        let session = await this.access();
        try {
            return await this.exchange(path, body, session.accessToken);
        } catch (error) {
            if (!(error instanceof PocketCastsError) || error.code !== "auth_required") throw error;
            session = await this.access(true);
            return this.exchange(path, body, session.accessToken);
        }
    }

    async list() {
        const session = await this.access();
        const result = await this.request("/user/playlists");
        if (!Array.isArray(result.playlists)) throw new PocketCastsError("invalid_playlist");
        const playlist = result.playlists.find(item => item.uuid === session.playlistId && item.manual && !item.isDeleted);
        if (!playlist) throw new PocketCastsError("playlist_missing");
        if (!Array.isArray(playlist.episodeOrder) || playlist.episodeOrder.length > 32) throw new PocketCastsError("playlist_limit");
        const details = [];
        for (const uuid of playlist.episodeOrder) details.push(await this.request("/user/episode", { uuid }));
        // The account API calls this field `episode`; the core uses `uuid`.
        return normalizePocketCasts({ ...playlist, episodes: playlist.episodes.map(entry => ({
            ...entry, uuid: entry.episode ?? entry.uuid,
        })) }, details);
    }

    async isPlayed(episodeUuid, podcastUuid) {
        const detail = await this.request("/user/episode", { uuid: episodeUuid });
        if (detail.uuid !== episodeUuid || detail.podcastUuid !== podcastUuid || ![1, 2, 3].includes(detail.playingStatus)) {
            throw new PocketCastsError("invalid_episode");
        }
        return detail.playingStatus === 3;
    }

    async markPlayed(episodeUuid, podcastUuid) {
        await this.request("/sync/update_episode", { uuid: episodeUuid, podcast: podcastUuid, status: 3 });
    }
}
