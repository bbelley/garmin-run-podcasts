import { normalizeUploads } from "../../backend-core/src/queue.mjs";

export async function loadUploads(bucket, config, origin) {
    const objects = [];
    let cursor;
    do {
        const page = await bucket.list({ include: ["customMetadata"], limit: 1000, ...(cursor ? { cursor } : {}) });
        objects.push(...page.objects.filter(object => /\.mp3$/i.test(object.key) && object.size > 0));
        cursor = page.truncated ? page.cursor : undefined;
        if (page.truncated && !cursor) throw new Error("missing_r2_cursor");
    } while (cursor);
    const keys = new Set(objects.map(object => object.key));
    const active = objects.filter(object => !keys.has(config.replacements?.[object.key]));
    active.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime() || a.key.localeCompare(b.key));
    const entries = [];
    for (const object of active.slice(0, 200)) {
        const meta = { ...config.episodeDetails?.[object.key], ...object.customMetadata };
        if (meta.addToRun === "false") continue;
        const duration = /^\d+$/.test(meta.duration ?? "") && Number(meta.duration) > 0 ? Number(meta.duration) : null;
        const encodedKey = object.key.split("/").map(encodeURIComponent).join("/");
        const entry = {
            guid: object.key,
            title: meta.title || object.key.split("/").pop().replace(/\.mp3$/i, "").replaceAll("_", " "),
            enclosureUrl: `${origin}/${config.feedPath}/audio/${encodedKey}`,
            enclosureBytes: object.size,
            durationSeconds: duration,
            pinned: meta.pinned === "true",
        };
        if (meta.pocketCastsVerified === "true") {
            entry.pocketCastsMatch = { verified: true, episodeUuid: meta.pocketCastsEpisodeUuid,
                podcastUuid: meta.pocketCastsPodcastUuid };
        }
        entries.push(entry);
    }
    return normalizeUploads("primary-uploads", entries);
}
