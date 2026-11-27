CREATE TABLE game_turns (
    account TEXT NOT NULL,
    story TEXT NOT NULL,
    message TEXT NOT NULL,
    token TEXT NOT NULL,
    first TEXT NOT NULL,
    revision TEXT NOT NULL,
    PRIMARY KEY(account,story,message,token),
    FOREIGN KEY(account,revision) REFERENCES sync_revisions(account,id)
);
CREATE TRIGGER record_game_turns AFTER INSERT ON sync_revisions BEGIN
    INSERT OR IGNORE INTO game_turns(account,story,message,token,first,revision)
    SELECT NEW.account,t.value->>'$.story',t.value->>'$.message',t.value->>'$.token',t.value->>'$.first',NEW.id
    FROM json_each(NEW.manifest,'$.turns') t WHERE t.value->>'$.first' IS NOT NULL;
END;
