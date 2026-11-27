
CREATE TABLE sync_revisions (
    account TEXT NOT NULL REFERENCES accounts(id),
    id TEXT NOT NULL,
    parent TEXT,
    branch TEXT NOT NULL,
    manifest TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY(account,id)
);
CREATE INDEX sync_history ON sync_revisions(account,branch,created);
CREATE TABLE sync_heads (
    account TEXT NOT NULL REFERENCES accounts(id),
    branch TEXT NOT NULL,
    revision TEXT NOT NULL,
    PRIMARY KEY(account,branch),
    FOREIGN KEY(account,revision) REFERENCES sync_revisions(account,id)
);
CREATE TRIGGER advance_sync_head AFTER INSERT ON sync_revisions BEGIN
    INSERT INTO sync_heads VALUES(NEW.account,NEW.branch,NEW.id)
    ON CONFLICT(account,branch) DO UPDATE SET revision=excluded.revision;
END;
