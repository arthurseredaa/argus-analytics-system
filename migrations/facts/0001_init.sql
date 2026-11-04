-- Facts database schema, copied from docs/design/data-model.md ("Tables in the D1 facts database").
-- Additive migrations only: later changes add columns or tables, never rebuild these.

CREATE TABLE users (
  id                TEXT PRIMARY KEY,   -- UserID from the identity cookie
  email_enc         TEXT NOT NULL,      -- AES-GCM ciphertext, "v1:<iv>:<ciphertext>" in base64
  email_hash        TEXT NOT NULL,      -- HMAC-SHA256 of the trimmed, lower-cased email, hex
  created_at        INTEGER NOT NULL,
  last_completed_at INTEGER NOT NULL
);
CREATE INDEX users_email_hash ON users (email_hash);

CREATE TABLE user_answers (
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,                      -- "gender", "ethnicity"
  value        TEXT NOT NULL CHECK (json_valid(value)),
  received_at  INTEGER NOT NULL,                   -- receive time of the completion request
  PRIMARY KEY (user_id, question_key)
);

CREATE TABLE partners (
  id                  TEXT PRIMARY KEY,   -- appears in /postback/v1/{partner_id}
  name                TEXT NOT NULL,
  active              INTEGER NOT NULL CHECK (active IN (0, 1)),
  secret_current_enc  TEXT NOT NULL,      -- AES-GCM under the master key
  secret_previous_enc TEXT                -- set during rotation, cleared after it
);

CREATE TABLE catalog_history (
  version    INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  changed_by TEXT NOT NULL,
  note       TEXT
);

CREATE TABLE offers (
  version    INTEGER NOT NULL REFERENCES catalog_history (version),
  id         TEXT NOT NULL,                       -- "001" ... "007"
  partner_id TEXT NOT NULL REFERENCES partners (id),
  name       TEXT NOT NULL,
  ethnicity  TEXT NOT NULL,                       -- asia | europe | latam | any
  genders    TEXT NOT NULL CHECK (json_valid(genders)),  -- ["women","men"]
  epu        REAL NOT NULL,
  url        TEXT NOT NULL,
  kind       TEXT NOT NULL,                       -- specialised | universal
  active     INTEGER NOT NULL CHECK (active IN (0, 1)),
  PRIMARY KEY (version, id)
);

CREATE TABLE clicks (
  click_id        TEXT PRIMARY KEY,            -- random, unguessable
  user_id         TEXT REFERENCES users (id) ON DELETE SET NULL,
  offer_id        TEXT NOT NULL,
  catalog_version INTEGER NOT NULL,
  prelander_id    TEXT NOT NULL,
  visit_id        TEXT NOT NULL,
  reason          TEXT NOT NULL,               -- best_epu | fallback_universal | lead_return
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (catalog_version, offer_id) REFERENCES offers (version, id)
);
CREATE INDEX clicks_user ON clicks (user_id);

CREATE TABLE conversions (
  id              INTEGER PRIMARY KEY,
  partner_id      TEXT NOT NULL REFERENCES partners (id),
  type            TEXT NOT NULL,              -- lead | purchase
  transaction_id  TEXT NOT NULL,
  click_id        TEXT NOT NULL REFERENCES clicks (click_id),
  occurred_at     INTEGER NOT NULL,           -- partner's time, from the body
  accepted_at     INTEGER NOT NULL,           -- our receive time
  payout          REAL,
  currency        TEXT,
  partner_user_id TEXT,                       -- optional contract field, kept for Q-19
  UNIQUE (partner_id, type, transaction_id)
);
CREATE INDEX conversions_click ON conversions (click_id);

CREATE TABLE quarantine (
  id             INTEGER PRIMARY KEY,
  partner_id     TEXT NOT NULL,
  type           TEXT,
  transaction_id TEXT,
  click_id       TEXT,          -- plain text on purpose: the click was not found
  body           TEXT NOT NULL, -- raw request body
  reason         TEXT NOT NULL, -- unknown_click
  received_at    INTEGER NOT NULL
);
