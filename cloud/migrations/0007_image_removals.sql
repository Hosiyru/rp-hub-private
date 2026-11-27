CREATE TABLE removed_images (
    account TEXT NOT NULL REFERENCES accounts(id),
    digest TEXT NOT NULL,
    token TEXT NOT NULL,
    PRIMARY KEY(account,digest)
);
ALTER TABLE chunks ADD COLUMN image TEXT;
CREATE INDEX chunks_by_image ON chunks(account,image) WHERE image IS NOT NULL;
