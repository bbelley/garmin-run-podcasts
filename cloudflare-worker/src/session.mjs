import { PocketCastsError } from "../../backend-core/src/outbox.mjs";

function fromBase64(value) {
    return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function toBase64(value) {
    return btoa(String.fromCharCode(...value));
}

export function tokenExpiry(token) {
    try {
        const part = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
        const value = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "="))).exp;
        return Number.isSafeInteger(value) ? value : 0;
    } catch {
        return 0;
    }
}

export function validateSession(data) {
    if (!data || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(data.playlistId)) throw new Error("invalid_session");
    for (const token of [data.accessToken, data.refreshToken]) {
        if (typeof token !== "string" || !token || token.length > 16384 || /\s/.test(token)) throw new Error("invalid_session");
    }
    return { accessToken: data.accessToken, refreshToken: data.refreshToken,
        playlistId: data.playlistId.toLowerCase(), expiresAt: tokenExpiry(data.accessToken) };
}

export class SessionStore {
    constructor(db, encodedKey) {
        this.db = db;
        this.encodedKey = encodedKey;
    }

    async key() {
        const raw = fromBase64(this.encodedKey);
        if (raw.length !== 32) throw new Error("invalid_session_key");
        return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    }

    async encrypt(data) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
            additionalData: new TextEncoder().encode("PaceJams session v1") }, await this.key(),
        new TextEncoder().encode(JSON.stringify(data)));
        return JSON.stringify({ iv: toBase64(iv), data: toBase64(new Uint8Array(ciphertext)) });
    }

    async get() {
        const row = await this.db.prepare("SELECT * FROM pocket_casts_session WHERE id = 'primary'").first();
        if (!row) return null;
        const encrypted = JSON.parse(row.encrypted_data);
        const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(encrypted.iv),
            additionalData: new TextEncoder().encode("PaceJams session v1") }, await this.key(), fromBase64(encrypted.data));
        return { data: JSON.parse(new TextDecoder().decode(clear)), version: row.version,
            reconnectRequired: Boolean(row.reconnect_required) };
    }

    async connect(input) {
        const data = validateSession(input);
        const encrypted = await this.encrypt(data);
        await this.db.prepare(`
            INSERT INTO pocket_casts_session (id, encrypted_data) VALUES ('primary', ?)
            ON CONFLICT(id) DO UPDATE SET encrypted_data = excluded.encrypted_data,
                version = pocket_casts_session.version + 1, reconnect_required = 0,
                lease_token = NULL, lease_until = NULL
        `).bind(encrypted).run();
    }

    async claim(version, now) {
        const lease = crypto.randomUUID();
        const row = await this.db.prepare(`
            UPDATE pocket_casts_session SET lease_token = ?, lease_until = ?
            WHERE id = 'primary' AND version = ? AND reconnect_required = 0
                AND (lease_until IS NULL OR lease_until <= ?) RETURNING version
        `).bind(lease, now + 30, version, now).first();
        return row ? lease : null;
    }

    async saveRefresh(data, version, lease) {
        const encrypted = await this.encrypt(validateSession(data));
        const result = await this.db.prepare(`
            UPDATE pocket_casts_session SET encrypted_data = ?, version = version + 1,
                reconnect_required = 0, lease_token = NULL, lease_until = NULL
            WHERE id = 'primary' AND version = ? AND lease_token = ?
        `).bind(encrypted, version, lease).run();
        if (!result.meta.changes) throw new PocketCastsError("retry_required", 2);
    }

    async release(version, lease, reconnect) {
        await this.db.prepare(`
            UPDATE pocket_casts_session SET lease_token = NULL, lease_until = NULL, reconnect_required = ?
            WHERE id = 'primary' AND version = ? AND lease_token = ?
        `).bind(reconnect ? 1 : 0, version, lease).run();
    }
}
