function publicHttps(value) {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.hash || host === "localhost" ||
        host.endsWith(".localhost") || host.endsWith(".internal") || host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host)) {
        throw new Error("unsafe_media_host");
    }
    return url;
}

async function mediaSize(value, fetcher, check) {
    let url = publicHttps(value);
    for (let redirects = 0; redirects < 6; redirects += 1) {
        const response = await fetcher(url.href, { method: "GET", headers: { Range: "bytes=0-9", "Accept-Encoding": "identity", "User-Agent": "PaceJams/0.1" },
            redirect: "manual", signal: AbortSignal.timeout(8000) });
        check.status = response.status;
        check.hops = redirects + 1;
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            const location = response.headers.get("Location");
            if (!location) { check.reason = "missing_redirect"; return null; }
            url = publicHttps(new URL(location, url).href);
            continue;
        }
        const type = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
        check.media_type = ["audio/mpeg", "audio/mp3", "audio/x-mp3", "application/octet-stream", "binary/octet-stream"].includes(type) ? type : "other";
        if (![200, 206].includes(response.status)) {
            await response.body?.cancel();
            check.reason = "http_error";
            return null;
        }
        let mp3 = ["audio/mpeg", "audio/mp3", "audio/x-mp3"].includes(type);
        if (["application/octet-stream", "binary/octet-stream"].includes(type)) {
            const prefix = await readPrefix(response.body, 10);
            mp3 = isMp3(prefix);
        } else {
            await response.body?.cancel();
        }
        if (!mp3) { check.reason = "unverified_mp3"; return null; }
        const range = response.headers.get("Content-Range")?.match(/^bytes 0-\d+\/(\d+)$/);
        const size = Number(response.status === 206 ? range?.[1] : response.headers.get("Content-Length"));
        const valid = Number.isSafeInteger(size) && size > 0;
        check.reason = valid ? "verified_size" : "missing_length";
        return valid ? size : null;
    }
    check.reason = "redirect_limit";
    return null;
}

async function readPrefix(body, limit) {
    if (!body) return new Uint8Array();
    const reader = body.getReader();
    const prefix = new Uint8Array(limit);
    let length = 0;
    try {
        while (length < limit) {
            const { value, done } = await reader.read();
            if (done) break;
            const count = Math.min(value.length, limit - length);
            prefix.set(value.subarray(0, count), length);
            length += count;
        }
    } finally {
        await reader.cancel();
    }
    return prefix.subarray(0, length);
}

function isMp3(bytes) {
    if (bytes.length < 4) return false;
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
        return bytes.length >= 10 && [2, 3, 4].includes(bytes[3]) && bytes.subarray(6, 10).every(byte => byte < 128);
    }
    return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && ((bytes[1] >> 3) & 3) !== 1 &&
        ((bytes[1] >> 1) & 3) === 1 && (bytes[2] >> 4) > 0 && (bytes[2] >> 4) < 15 && ((bytes[2] >> 2) & 3) !== 3;
}

export async function enrichUpcomingSizes(items, fetcher = fetch) {
    fetcher = fetcher.bind(globalThis);
    let checked = 0;
    const enriched = [];
    for (const item of items) {
        let size = item.sizeBytes;
        let sizeCheck;
        if (!item.played && size === null && checked < 3) {
            checked += 1;
            sizeCheck = { reason: "request_failed", hops: 0 };
            try { size = await mediaSize(item.audioUrl, fetcher, sizeCheck); } catch { size = null; }
        }
        enriched.push({ ...item, sizeBytes: size, ...(sizeCheck ? { sizeCheck } : {}) });
    }
    return enriched;
}
