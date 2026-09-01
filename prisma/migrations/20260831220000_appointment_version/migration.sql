ALTER TABLE appointments ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE appointments ADD CONSTRAINT appointments_version_nonnegative CHECK (version >= 0);
CREATE INDEX appointments_starts_at_id_idx ON appointments (starts_at, id);
