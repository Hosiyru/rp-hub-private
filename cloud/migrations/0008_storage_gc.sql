ALTER TABLE chunks ADD COLUMN created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chunks ADD COLUMN pending_delete INTEGER NOT NULL DEFAULT 0;
UPDATE chunks SET created=unixepoch();
CREATE INDEX chunks_gc ON chunks(account,pending_delete,created);
CREATE TRIGGER chunks_created_on_legacy_upload AFTER INSERT ON chunks WHEN NEW.created=0
BEGIN
    UPDATE chunks SET created=unixepoch() WHERE account=NEW.account AND hash=NEW.hash;
END;
CREATE TABLE gc_state (
    account TEXT PRIMARY KEY REFERENCES accounts(id),
    last_run INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0
);
