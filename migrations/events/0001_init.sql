-- MVP stand-in for BigQuery (ADR 0005); removed when the loader targets BigQuery.
-- Columns follow the envelope in docs/design/data-model.md. client_time and seq are
-- null for server events.

CREATE TABLE events (
  event_id       TEXT NOT NULL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  type           TEXT NOT NULL,
  client_time    INTEGER,
  received_at    INTEGER NOT NULL,
  -- null for lead and purchase whose click lost its user (deletion or the 90-day
  -- cleanup sets clicks.user_id to null)
  user_id        TEXT,
  visit_id       TEXT NOT NULL,
  seq            INTEGER,
  prelander_id   TEXT NOT NULL,
  payload        TEXT NOT NULL CHECK (json_valid(payload))
);
