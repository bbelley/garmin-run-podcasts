PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS catalog_items (
    id TEXT PRIMARY KEY,
    canonical_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    episode_uuid TEXT,
    podcast_uuid TEXT,
    CHECK ((episode_uuid IS NULL) = (podcast_uuid IS NULL))
);

CREATE TRIGGER IF NOT EXISTS catalog_mapping_conflict
BEFORE UPDATE ON catalog_items
WHEN OLD.episode_uuid IS NOT NULL AND
    (NEW.episode_uuid IS NOT OLD.episode_uuid OR NEW.podcast_uuid IS NOT OLD.podcast_uuid)
BEGIN
    SELECT RAISE(ABORT, 'catalog_mapping_conflict');
END;

CREATE TABLE IF NOT EXISTS watch_events (
    event_id TEXT PRIMARY KEY,
    watch_id TEXT NOT NULL,
    item_id TEXT NOT NULL REFERENCES catalog_items(id),
    reason TEXT NOT NULL CHECK (reason IN ('natural_end', 'mark_finished')),
    occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
    received_at INTEGER NOT NULL CHECK (received_at >= 0)
);

CREATE TRIGGER IF NOT EXISTS event_identity_conflict
BEFORE INSERT ON watch_events
WHEN EXISTS (
    SELECT 1 FROM watch_events WHERE event_id = NEW.event_id AND (
        watch_id != NEW.watch_id OR item_id != NEW.item_id OR
        reason != NEW.reason OR occurred_at != NEW.occurred_at
    )
)
BEGIN
    SELECT RAISE(ABORT, 'event_identity_conflict');
END;

CREATE TABLE IF NOT EXISTS completions (
    item_id TEXT PRIMARY KEY REFERENCES catalog_items(id),
    event_id TEXT NOT NULL REFERENCES watch_events(event_id),
    completed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pocket_casts_outbox (
    item_id TEXT PRIMARY KEY REFERENCES catalog_items(id),
    episode_uuid TEXT NOT NULL,
    podcast_uuid TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'delivered', 'auth_required')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER,
    last_error TEXT,
    delivered_at INTEGER
);

CREATE INDEX IF NOT EXISTS outbox_due ON pocket_casts_outbox(state, next_attempt_at, lease_until);

CREATE TABLE IF NOT EXISTS source_snapshots (
    source TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
