import { validateItems, ITEM_ID } from "./queue.mjs";

const EVENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class InputError extends Error {}

export function validateEvents(events) {
    if (!Array.isArray(events) || events.length > 32) throw new InputError("invalid_events");
    const unique = new Map();
    for (const event of events) {
        if (!event || typeof event.event_id !== "string" || !EVENT_ID.test(event.event_id) ||
            typeof event.item_id !== "string" || !ITEM_ID.test(event.item_id) ||
            !["natural_end", "mark_finished"].includes(event.reason) ||
            !Number.isSafeInteger(event.occurred_at) || event.occurred_at < 0) throw new InputError("invalid_event");
        const value = {
            event_id: event.event_id, item_id: event.item_id,
            reason: event.reason, occurred_at: event.occurred_at,
        };
        const previous = unique.get(value.event_id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new InputError("event_identity_conflict");
        unique.set(value.event_id, value);
    }
    return [...unique.values()];
}

const ENQUEUE_COMPLETIONS = `
    INSERT INTO pocket_casts_outbox (item_id, episode_uuid, podcast_uuid)
    SELECT DISTINCT c.canonical_id, c.episode_uuid, c.podcast_uuid
    FROM completions done JOIN catalog_items c ON c.id = done.item_id
    WHERE c.episode_uuid IS NOT NULL
    ON CONFLICT(item_id) DO NOTHING
`;

export class D1Store {
    constructor(db) {
        this.db = db;
    }

    async saveCatalog(items) {
        validateItems(items);
        const statements = [];
        for (const item of items) {
            const aliases = [...new Set([item.id, ...item.aliases])];
            for (const alias of aliases) {
                statements.push(this.db.prepare(`
                    INSERT INTO catalog_items (id, canonical_id, payload_json, episode_uuid, podcast_uuid)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET canonical_id = excluded.canonical_id,
                        payload_json = excluded.payload_json,
                        episode_uuid = excluded.episode_uuid, podcast_uuid = excluded.podcast_uuid
                `).bind(alias, item.id, JSON.stringify(item), item.pocketCasts?.episodeUuid ?? null, item.pocketCasts?.podcastUuid ?? null));
            }
        }
        // Verified matches can become available after a personal upload was completed.
        statements.push(this.db.prepare(ENQUEUE_COMPLETIONS));
        await this.db.batch(statements);
    }

    async item(id) {
        const row = await this.db.prepare("SELECT payload_json FROM catalog_items WHERE id = ?").bind(id).first();
        return row ? JSON.parse(row.payload_json) : null;
    }

    async recordCompletions(watchId, input, now) {
        if (typeof watchId !== "string" || !EVENT_ID.test(watchId)) throw new InputError("invalid_watch");
        if (!Number.isSafeInteger(now) || now < 0) throw new InputError("invalid_time");
        const events = validateEvents(input);
        if (!events.length) return [];
        const statements = [];
        for (const event of events) {
            statements.push(this.db.prepare(`
                INSERT INTO watch_events (event_id, watch_id, item_id, reason, occurred_at, received_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING
            `).bind(event.event_id, watchId, event.item_id, event.reason, event.occurred_at, now));
            statements.push(this.db.prepare(`
                INSERT INTO completions (item_id, event_id, completed_at)
                SELECT item_id, event_id, occurred_at FROM watch_events WHERE event_id = ?
                ON CONFLICT(item_id) DO NOTHING
            `).bind(event.event_id));
        }
        statements.push(this.db.prepare(ENQUEUE_COMPLETIONS));
        // D1 batch commits the event, completion, and outbox together before acknowledgement.
        await this.db.batch(statements);
        return events.map(event => event.event_id);
    }

    async completedIds() {
        const { results } = await this.db.prepare(`
            SELECT DISTINCT alias.id FROM completions done
            JOIN catalog_items completed ON completed.id = done.item_id
            JOIN catalog_items alias ON alias.canonical_id = completed.canonical_id
        `).all();
        return results.map(row => row.id);
    }

    async deliveryStatus() {
        const { results } = await this.db.prepare(`
            SELECT state, COUNT(*) AS count FROM pocket_casts_outbox GROUP BY state
        `).all();
        return Object.fromEntries(results.map(row => [row.state, row.count]));
    }

    async saveSnapshot(source, items, now) {
        await this.db.prepare(`
            INSERT INTO source_snapshots (source, payload_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(source) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
            WHERE excluded.updated_at >= source_snapshots.updated_at
        `).bind(source, JSON.stringify(items), now).run();
    }

    async snapshot(source) {
        const row = await this.db.prepare("SELECT * FROM source_snapshots WHERE source = ?").bind(source).first();
        return row ? { items: JSON.parse(row.payload_json), updatedAt: row.updated_at } : null;
    }

    async claimDelivery(now, leaseSeconds = 120) {
        const leaseToken = crypto.randomUUID();
        return this.db.prepare(`
            UPDATE pocket_casts_outbox SET state = 'processing', lease_token = ?, lease_until = ?, attempts = attempts + 1
            WHERE item_id = (
                SELECT item_id FROM pocket_casts_outbox
                WHERE (state = 'pending' AND next_attempt_at <= ?)
                    OR (state = 'processing' AND lease_until <= ?)
                ORDER BY next_attempt_at, item_id LIMIT 1
            )
            RETURNING *
        `).bind(leaseToken, now + leaseSeconds, now, now).first();
    }

    async finishDelivery(item, now) {
        await this.db.prepare(`
            UPDATE pocket_casts_outbox SET state = 'delivered', delivered_at = ?,
                lease_token = NULL, lease_until = NULL, last_error = NULL
            WHERE item_id = ? AND state = 'processing' AND lease_token = ?
        `).bind(now, item.item_id, item.lease_token).run();
    }

    async failDelivery(item, now, code, retryAfter = 0) {
        const needsAuth = code === "auth_required";
        const delay = Math.max(Math.min(3600, 30 * 2 ** Math.min(item.attempts - 1, 7)), retryAfter);
        await this.db.prepare(`
            UPDATE pocket_casts_outbox SET state = ?, next_attempt_at = ?, last_error = ?,
                lease_token = NULL, lease_until = NULL
            WHERE item_id = ? AND state = 'processing' AND lease_token = ?
        `).bind(needsAuth ? "auth_required" : "pending", now + delay, code, item.item_id, item.lease_token).run();
    }

    async resumeDeliveries(now) {
        await this.db.prepare(`
            UPDATE pocket_casts_outbox SET state = 'pending', next_attempt_at = ?, last_error = NULL
            WHERE state = 'auth_required'
        `).bind(now).run();
    }
}
