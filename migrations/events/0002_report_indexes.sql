-- Every events statement of the report filters on a received_at range (R-17, stage 4).
CREATE INDEX events_received_at ON events (received_at);
