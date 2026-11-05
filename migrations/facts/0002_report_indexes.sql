-- The cohort view reads clicks by created_at; the postback view reads conversions by type and
-- accepted_at (R-17, stage 4).
CREATE INDEX clicks_created_at ON clicks (created_at);
CREATE INDEX conversions_type_accepted ON conversions (type, accepted_at);
