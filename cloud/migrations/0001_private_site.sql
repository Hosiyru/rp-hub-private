CREATE TABLE site (id TEXT PRIMARY KEY, singleton INTEGER NOT NULL UNIQUE CHECK(singleton=1));
INSERT INTO site VALUES (lower(hex(randomblob(16))),1);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, login_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','player'))
);
CREATE UNIQUE INDEX first_owner ON accounts(role) WHERE role='owner';
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL
);
CREATE TABLE tickets (
  token_hash TEXT PRIMARY KEY, issuer TEXT NOT NULL REFERENCES accounts(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('pair','invite')), expires INTEGER NOT NULL, redeemed TEXT
);
CREATE TABLE chunks (
  account TEXT NOT NULL REFERENCES accounts(id), hash TEXT NOT NULL, bytes INTEGER NOT NULL,
  PRIMARY KEY(account,hash)
);
CREATE TABLE archives (
  account TEXT NOT NULL REFERENCES accounts(id), digest TEXT NOT NULL, manifest TEXT NOT NULL,
  created INTEGER NOT NULL, PRIMARY KEY(account,digest)
);
CREATE TABLE probes (id TEXT PRIMARY KEY, consumed INTEGER NOT NULL DEFAULT 0);
