ALTER TABLE business_settings ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE business_settings ADD CONSTRAINT business_settings_version_nonnegative CHECK (version >= 0);
