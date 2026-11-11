import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { normalizePocketCasts, normalizeUploads, mergeSources } from "../src/queue.mjs";

export const episodeUuid = "00000000-0000-0000-0000-000000000001";
export const podcastUuid = "00000000-0000-0000-0000-000000000002";

class Statement {
    constructor(db, sql, bindings = []) {
        this.db = db;
        this.sql = sql;
        this.bindings = bindings;
    }
    bind(...bindings) { return new Statement(this.db, this.sql, bindings); }
    statement() { return this.db.sqlite.prepare(this.sql); }
    async first() { return this.statement().get(...this.bindings) ?? null; }
    async all() { return { success: true, results: this.statement().all(...this.bindings) }; }
    async run() {
        const result = this.statement().run(...this.bindings);
        return { success: true, meta: { changes: result.changes } };
    }
}

export class SqliteD1 {
    constructor(path = ":memory:") {
        this.sqlite = new DatabaseSync(path);
        this.sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
        this.failSql = null;
    }
    prepare(sql) { return new Statement(this, sql); }
    async batch(statements) {
        this.sqlite.exec("BEGIN IMMEDIATE");
        try {
            const results = statements.map(statement => {
                if (this.failSql?.(statement.sql)) throw new Error("injected_storage_failure");
                const result = statement.statement().run(...statement.bindings);
                return { success: true, meta: { changes: result.changes } };
            });
            this.sqlite.exec("COMMIT");
            return results;
        } catch (error) {
            this.sqlite.exec("ROLLBACK");
            throw error;
        }
    }
    rows(table) { return this.sqlite.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row })); }
    close() { this.sqlite.close(); }
}

export async function fixtureItems() {
    const pocketCasts = await normalizePocketCasts({
        episodes: [{ uuid: episodeUuid, podcast: podcastUuid }], episodeOrder: [episodeUuid],
    }, [{ uuid: episodeUuid, podcastUuid, title: "Fixture episode", playingStatus: 1,
        duration: 600, sizeBytes: 100, url: "https://audio.example.com/episode.mp3" }]);
    const uploads = await normalizeUploads("fixture-feed", [
        { guid: "upload-one", title: "Personal clip", enclosureUrl: "https://audio.example.com/upload.mp3", enclosureBytes: 80 },
    ]);
    return { pocketCasts, uploads, items: mergeSources(pocketCasts, uploads) };
}

export const storage = { capacityBytes: 1000, usedBytes: 0, budgetBytes: 500, reserveBytes: 100 };
export const eventFor = (item, eventId = "fixture-event") => ({
    event_id: eventId, item_id: item.id, reason: "natural_end", occurred_at: 100,
});
