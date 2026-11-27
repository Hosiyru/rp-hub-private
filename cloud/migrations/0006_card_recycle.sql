-- Pin the confirmed deletion and its preceding revision independently of later client snapshots.
CREATE TABLE card_recycle (
    account TEXT NOT NULL,
    branch TEXT NOT NULL,
    card TEXT NOT NULL,
    revision TEXT NOT NULL,
    parent TEXT,
    removed INTEGER NOT NULL,
    PRIMARY KEY(account,revision,card),
    FOREIGN KEY(account,revision) REFERENCES sync_revisions(account,id)
);
CREATE INDEX recycle_by_date ON card_recycle(account,removed);

CREATE TRIGGER pin_card_deletion AFTER INSERT ON sync_revisions BEGIN
    INSERT INTO card_recycle(account,branch,card,revision,parent,removed)
    SELECT NEW.account,NEW.branch,value,NEW.id,NEW.parent,NEW.created FROM (
        SELECT value FROM json_each(NEW.manifest,'$.deleted')
        EXCEPT
        SELECT t.value FROM sync_revisions p,json_each(p.manifest,'$.deleted') t
        WHERE p.account=NEW.account AND p.id=NEW.parent
    );
END;

-- Include deletions from supported pre-upgrade revisions within the same retention window.
INSERT INTO card_recycle(account,branch,card,revision,parent,removed)
SELECT r.account,r.branch,t.value,r.id,r.parent,r.created
FROM sync_revisions r,json_each(r.manifest,'$.deleted') t
WHERE r.created>unixepoch()-2592000 AND NOT EXISTS (
    SELECT 1 FROM sync_revisions p,json_each(p.manifest,'$.deleted') old
    WHERE p.account=r.account AND p.id=r.parent AND old.value=t.value
)
ON CONFLICT DO NOTHING;
