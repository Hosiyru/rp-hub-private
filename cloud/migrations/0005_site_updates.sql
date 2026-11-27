CREATE TABLE IF NOT EXISTS site_updates (
    singleton INTEGER PRIMARY KEY CHECK (singleton=1),
    version TEXT NOT NULL DEFAULT '',
    revision TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'idle',
    changed INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO site_updates(singleton) VALUES(1);
