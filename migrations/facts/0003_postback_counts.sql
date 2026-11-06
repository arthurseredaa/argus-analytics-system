-- Postback requests per partner and UTC minute, read by the postbacks_without_conversions alert
-- (metrics-and-operations.md "Alerts"; stage 6 plan decision 15). The alert run deletes rows older than a day.
CREATE TABLE postback_counts (
  minute     INTEGER NOT NULL, -- Unix milliseconds, truncated to the minute
  partner_id TEXT NOT NULL,
  requests   INTEGER NOT NULL,
  accepted   INTEGER NOT NULL, -- accepted and duplicate outcomes
  PRIMARY KEY (minute, partner_id)
) WITHOUT ROWID;
