const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const ITEM_ID = /^pj_[a-f0-9]{64}$/;

function uuid(value) {
    if (typeof value !== "string" || !UUID.test(value)) throw new Error("invalid_identity");
    return value.toLowerCase();
}

function title(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 1024) throw new Error("invalid_title");
    return value.trim();
}

function httpsUrl(value) {
    if (typeof value !== "string" || value.length > 8192) throw new Error("invalid_audio_url");
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error("invalid_audio_url");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
        throw new Error("invalid_audio_url");
    }
    // Keep the original enclosure. Source URLs can carry signatures or encoded paths.
    return value;
}

function optionalNumber(value, integer = false) {
    if (value === null || value === undefined) return null;
    if (!Number.isFinite(value) || value < 0 || (integer && (!Number.isSafeInteger(value) || value === 0))) {
        throw new Error("invalid_media_size_or_duration");
    }
    return value;
}

export function validateItems(items) {
    if (!Array.isArray(items)) throw new Error("invalid_source");
    for (const item of items) {
        if (!item || typeof item.id !== "string" || !ITEM_ID.test(item.id) ||
            !Array.isArray(item.aliases) || !item.aliases.includes(item.id) ||
            item.aliases.some(id => typeof id !== "string" || !ITEM_ID.test(id)) ||
            !["upload", "pocketcasts"].includes(item.source) ||
            (item.source === "pocketcasts" && !item.pocketCasts) ||
            typeof item.played !== "boolean" || typeof item.pinned !== "boolean") throw new Error("invalid_source");
        title(item.title);
        httpsUrl(item.audioUrl);
        optionalNumber(item.sizeBytes, true);
        optionalNumber(item.durationSeconds);
        if (item.pocketCasts) {
            uuid(item.pocketCasts.episodeUuid);
            uuid(item.pocketCasts.podcastUuid);
        }
    }
    return items;
}

export async function itemId(namespace, identity) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([namespace, identity])));
    return "pj_" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function normalizePocketCasts(playlist, details) {
    if (!Array.isArray(playlist?.episodes) || !Array.isArray(playlist?.episodeOrder) || !Array.isArray(details)) {
        throw new Error("invalid_playlist");
    }
    const entries = new Map();
    for (const entry of playlist.episodes) {
        const key = uuid(entry.uuid);
        if (entries.has(key)) throw new Error("duplicate_episode");
        entries.set(key, entry);
    }
    const byId = new Map();
    for (const detail of details) {
        const key = uuid(detail.uuid);
        if (byId.has(key)) throw new Error("duplicate_detail");
        byId.set(key, detail);
    }
    const order = playlist.episodeOrder.map(uuid);
    if (new Set(order).size !== order.length || order.length !== entries.size) throw new Error("invalid_playlist_order");
    const items = [];
    for (const episodeUuid of order) {
        const entry = entries.get(episodeUuid);
        const detail = byId.get(episodeUuid);
        if (!entry || !detail || ![1, 2, 3].includes(detail.playingStatus)) throw new Error("incomplete_episode");
        const podcastUuid = uuid(detail.podcastUuid ?? entry.podcast);
        if (entry.podcast && uuid(entry.podcast) !== podcastUuid) throw new Error("podcast_identity_conflict");
        const id = await itemId("pocketcasts", episodeUuid);
        items.push({
            id, aliases: [id], source: "pocketcasts",
            title: title(detail.title ?? entry.title),
            audioUrl: httpsUrl(detail.url ?? entry.url),
            durationSeconds: optionalNumber(detail.duration),
            sizeBytes: optionalNumber(detail.sizeBytes, true),
            played: detail.playingStatus === 3, pinned: false,
            pocketCasts: { episodeUuid, podcastUuid },
        });
    }
    return items;
}

export async function normalizeUploads(feedKey, entries) {
    if (typeof feedKey !== "string" || !feedKey || !Array.isArray(entries)) throw new Error("invalid_upload_feed");
    const items = [];
    const seen = new Set();
    for (const entry of entries) {
        if (typeof entry.guid !== "string" || !entry.guid || entry.guid.length > 2048) throw new Error("invalid_upload_identity");
        const uploadId = await itemId("upload", [feedKey, entry.guid]);
        if (seen.has(uploadId)) throw new Error("duplicate_upload");
        seen.add(uploadId);
        let pocketCasts = null;
        let id = uploadId;
        if (entry.pocketCastsMatch) {
            const match = entry.pocketCastsMatch;
            if (match.verified !== true) throw new Error("unverified_pocketcasts_match");
            pocketCasts = { episodeUuid: uuid(match.episodeUuid), podcastUuid: uuid(match.podcastUuid) };
            id = await itemId("pocketcasts", pocketCasts.episodeUuid);
        }
        if (entry.pinned !== undefined && typeof entry.pinned !== "boolean") throw new Error("invalid_pin");
        items.push({
            id, aliases: [...new Set([id, uploadId])], source: "upload",
            title: title(entry.title), audioUrl: httpsUrl(entry.enclosureUrl),
            durationSeconds: optionalNumber(entry.durationSeconds),
            sizeBytes: optionalNumber(entry.enclosureBytes, true),
            played: false, pinned: entry.pinned === true, pocketCasts,
        });
    }
    return items;
}

export function mergeSources(pocketCasts, uploads) {
    validateItems(pocketCasts);
    validateItems(uploads);
    const merged = new Map();
    for (const item of [...pocketCasts, ...uploads]) {
        const previous = merged.get(item.id);
        if (!previous) {
            merged.set(item.id, { ...item, aliases: [...item.aliases] });
            continue;
        }
        if (previous.pocketCasts && item.pocketCasts &&
            previous.pocketCasts.podcastUuid !== item.pocketCasts.podcastUuid) throw new Error("podcast_identity_conflict");
        const content = previous.pinned && !item.pinned ? previous : item;
        merged.set(item.id, {
            ...previous, ...content,
            aliases: [...new Set([...previous.aliases, ...item.aliases])],
            played: previous.played || item.played,
            pinned: previous.pinned || item.pinned,
            pocketCasts: previous.pocketCasts ?? item.pocketCasts,
        });
    }
    const aliasOwners = new Map();
    for (const item of merged.values()) {
        for (const alias of item.aliases) {
            if (aliasOwners.has(alias) && aliasOwners.get(alias) !== item.id) throw new Error("alias_identity_conflict");
            aliasOwners.set(alias, item.id);
        }
    }
    const ordered = [];
    const seen = new Set();
    for (const item of [...uploads.filter(item => item.pinned), ...pocketCasts, ...uploads]) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        ordered.push(merged.get(item.id));
    }
    return ordered;
}

function bytes(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_storage");
    return value;
}

export function planQueue(items, options) {
    const { inProgressId = null, completedIds = [], suppressedIds = [], downloads = [], storage } = options;
    if (inProgressId !== null && (typeof inProgressId !== "string" || !ITEM_ID.test(inProgressId))) throw new Error("invalid_progress");
    for (const ids of [completedIds, suppressedIds]) {
        if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !ITEM_ID.test(id))) throw new Error("invalid_item_ids");
    }
    if (!Array.isArray(downloads) || downloads.length > 64 || !storage) throw new Error("invalid_storage");
    const capacity = bytes(storage.capacityBytes);
    const used = bytes(storage.usedBytes);
    const reserve = bytes(storage.reserveBytes);
    const budget = Math.min(bytes(storage.budgetBytes), Math.max(0, capacity - reserve));
    if (used > capacity) throw new Error("invalid_storage");
    const cached = new Map();
    for (const download of downloads) {
        if (!download || typeof download.id !== "string" || !ITEM_ID.test(download.id) || cached.has(download.id)) throw new Error("invalid_downloads");
        const size = bytes(download.bytes);
        if (size === 0) throw new Error("invalid_downloads");
        cached.set(download.id, size);
    }
    if ([...cached.values()].reduce((sum, size) => sum + size, 0) > used) throw new Error("invalid_storage");
    const completed = new Set(completedIds);
    for (const item of items) {
        if (item.played || item.aliases.some(id => completed.has(id))) {
            for (const id of item.aliases) completed.add(id);
        }
    }
    const suppressed = new Set(suppressedIds);
    const evictIds = [...cached.keys()].filter(id => completed.has(id));
    const reclaimable = evictIds.reduce((sum, id) => sum + cached.get(id), 0);
    let headroom = Math.max(0, capacity - used - reserve + reclaimable);
    let selectedBytes = 0;
    let upcoming = 0;
    const selected = [];
    const deferred = [];
    const eligible = items.filter(item => !item.aliases.some(id => completed.has(id) || suppressed.has(id)));
    const current = eligible.find(item => item.aliases.includes(inProgressId));
    const ordered = current ? [current, ...eligible.filter(item => item !== current)] : eligible;
    const protectedIds = current ? [...current.aliases] : [inProgressId].filter(id =>
        id && !completed.has(id) && !suppressed.has(id));
    for (const item of ordered) {
        const isCurrent = item === current;
        if (!isCurrent && upcoming >= 2) continue;
        const cachedId = item.aliases.find(id => cached.has(id));
        const size = cachedId ? cached.get(cachedId) : item.sizeBytes;
        let reason = null;
        if (size === null || size === undefined) reason = "unknown_size";
        else if (!(isCurrent && cachedId) && selectedBytes + size > budget) reason = "budget";
        else if (!cachedId && size > headroom) reason = "free_space";
        if (reason) {
            deferred.push({ id: item.id, reason });
            continue;
        }
        selectedBytes += size;
        if (!cachedId) headroom -= size;
        if (!isCurrent) upcoming += 1;
        selected.push({
            id: item.id, title: item.title, source: item.source,
            duration_seconds: item.durationSeconds, size_bytes: size, audio_url: item.audioUrl,
            cached_id: cachedId ?? null, download: !cachedId,
        });
    }
    const selectedCachedIds = new Set(selected.map(item => item.cached_id));
    const retireAfterDownloadIds = [...cached.keys()].filter(id =>
        !evictIds.includes(id) && !protectedIds.includes(id) && !selectedCachedIds.has(id));
    return { items: selected, deferred, evictIds, retireAfterDownloadIds, protectedIds, selectedBytes };
}
