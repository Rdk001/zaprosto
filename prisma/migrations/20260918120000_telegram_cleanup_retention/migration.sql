-- Cleanup selectors are deliberately partial/expression indexes so bounded
-- retention runs do not scan live polling/delivery rows.
CREATE INDEX "notification_outbox_terminal_cleanup_idx"
ON "notification_outbox" ("finished_at", "id")
WHERE "status" IN ('SENT', 'DEAD', 'CANCELLED', 'SKIPPED');

CREATE INDEX "telegram_link_tokens_terminal_cleanup_idx"
ON "telegram_link_tokens" (
  LEAST(
    "expires_at",
    COALESCE("used_at", 'infinity'::timestamptz),
    COALESCE("revoked_at", 'infinity'::timestamptz)
  ),
  "id"
);

CREATE INDEX "appointment_telegram_connections_disabled_cleanup_idx"
ON "appointment_telegram_connections" ("disabled_at", "id")
WHERE "disabled_at" IS NOT NULL;

CREATE INDEX "admin_telegram_connections_disabled_cleanup_idx"
ON "admin_telegram_connections" ("disabled_at", "id")
WHERE "disabled_at" IS NOT NULL;
