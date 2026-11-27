CREATE TABLE generation_jobs (
    account TEXT NOT NULL,
    id TEXT NOT NULL,
    revision TEXT NOT NULL,
    story TEXT NOT NULL,
    message TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    reply_tool INTEGER NOT NULL,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    mime TEXT,
    updated INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY(account,id),
    FOREIGN KEY(account,revision) REFERENCES sync_revisions(account,id)
);
CREATE TABLE generation_keys (
    account TEXT NOT NULL REFERENCES accounts(id),
    endpoint TEXT NOT NULL,
    encrypted BLOB NOT NULL,
    PRIMARY KEY(account,endpoint)
);
CREATE INDEX generation_pending ON generation_jobs(status,updated);
CREATE TABLE generation_parts (
    account TEXT NOT NULL,
    job TEXT NOT NULL,
    seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY(account,job,seq),
    FOREIGN KEY(account,job) REFERENCES generation_jobs(account,id)
);
