CREATE TABLE IF NOT EXISTS pocket_casts_session (
    id TEXT PRIMARY KEY CHECK (id = 'primary'),
    encrypted_data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    reconnect_required INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER
);
