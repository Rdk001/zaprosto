BEGIN;

-- Fail closed before any destructive DDL. The legacy tables were never used in
-- the accepted baseline, so any row requires an explicit investigation.
DO $preflight$
BEGIN
    IF EXISTS (SELECT 1 FROM "telegram_links" LIMIT 1) THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'Telegram migration preflight failed: legacy table telegram_links contains rows';
    END IF;

    IF EXISTS (SELECT 1 FROM "notification_outbox" LIMIT 1) THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'Telegram migration preflight failed: legacy table notification_outbox contains rows';
    END IF;
END
$preflight$;

DROP TABLE "notification_outbox";
DROP TABLE "telegram_links";
DROP TYPE "NotificationStatus";
DROP TYPE "NotificationType";

CREATE TYPE "TelegramLinkPurpose" AS ENUM (
    'APPOINTMENT',
    'ADMIN_USER'
);

CREATE TYPE "TelegramConnectionDisabledReason" AS ENUM (
    'USER_DISCONNECTED',
    'BOT_REPLACED',
    'BOT_BLOCKED',
    'CHAT_NOT_FOUND',
    'CHAT_WRITE_FORBIDDEN',
    'TELEGRAM_USER_DEACTIVATED',
    'ADMIN_USER_DEACTIVATED'
);

CREATE TYPE "NotificationRecipientKind" AS ENUM (
    'APPOINTMENT_CONNECTION',
    'ADMIN_CONNECTION',
    'DIRECT_CHAT'
);

CREATE TYPE "NotificationType" AS ENUM (
    'CLIENT_CONNECTION_CONFIRMED',
    'ADMIN_CONNECTION_CONFIRMED',
    'TELEGRAM_CONNECTION_REJECTED',
    'CLIENT_APPOINTMENT_CANCELLED',
    'CLIENT_APPOINTMENT_CHANGED',
    'CLIENT_APPOINTMENT_REMINDER',
    'ADMIN_APPOINTMENT_CREATED',
    'ADMIN_APPOINTMENT_CANCELLED'
);

CREATE TYPE "NotificationStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'SENT',
    'DEAD',
    'CANCELLED',
    'SKIPPED'
);

CREATE TABLE "telegram_bot_state" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "bot_user_id" BIGINT,
    "bot_username" VARCHAR(32),
    "next_update_id" BIGINT NOT NULL DEFAULT 0,
    "last_verified_at" TIMESTAMPTZ(3),
    "last_poll_at" TIMESTAMPTZ(3),
    "last_error_code" VARCHAR(64),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "telegram_bot_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "telegram_bot_state_singleton_check" CHECK ("id" = 1),
    CONSTRAINT "telegram_bot_state_next_update_id_check" CHECK ("next_update_id" >= 0),
    CONSTRAINT "telegram_bot_state_identity_pair_check" CHECK (
        ("bot_user_id" IS NULL) = ("bot_username" IS NULL)
    ),
    CONSTRAINT "telegram_bot_state_bot_user_id_check" CHECK (
        "bot_user_id" IS NULL OR "bot_user_id" > 0
    ),
    CONSTRAINT "telegram_bot_state_bot_username_check" CHECK (
        "bot_username" IS NULL OR (
            char_length("bot_username") > 0
            AND left("bot_username", 1) <> '@'
        )
    ),
    CONSTRAINT "telegram_bot_state_last_error_code_check" CHECK (
        "last_error_code" IS NULL OR "last_error_code" IN (
            'NETWORK_UNREACHABLE',
            'DELIVERY_OUTCOME_UNKNOWN',
            'TELEGRAM_RATE_LIMIT',
            'TELEGRAM_5XX',
            'INVALID_REQUEST',
            'CHAT_NOT_FOUND',
            'BOT_BLOCKED',
            'CHAT_WRITE_FORBIDDEN',
            'TELEGRAM_USER_DEACTIVATED',
            'CONFIG_UNAUTHORIZED',
            'BOT_IDENTITY_MISMATCH',
            'WEBHOOK_ACTIVE',
            'POLL_OFFSET_CONFLICT',
            'POLLING_CONFLICT',
            'RESPONSE_INVALID',
            'RESPONSE_TOO_LARGE',
            'PAYLOAD_VERSION_UNSUPPORTED',
            'REMINDER_EXPIRED',
            'CONNECTION_INACTIVE',
            'APPOINTMENT_NOT_SCHEDULED',
            'VISIT_MISMATCH'
        )
    )
);

CREATE TABLE "telegram_link_tokens" (
    "id" UUID NOT NULL,
    "purpose" "TelegramLinkPurpose" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "appointment_id" UUID,
    "admin_user_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "used_by_update_id" BIGINT,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_link_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "telegram_link_tokens_token_hash_check" CHECK (
        "token_hash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "telegram_link_tokens_target_check" CHECK (
        ("appointment_id" IS NOT NULL)::INTEGER
        + ("admin_user_id" IS NOT NULL)::INTEGER = 1
    ),
    CONSTRAINT "telegram_link_tokens_purpose_target_check" CHECK (
        (
            "purpose" = 'APPOINTMENT'
            AND "appointment_id" IS NOT NULL
            AND "admin_user_id" IS NULL
        )
        OR (
            "purpose" = 'ADMIN_USER'
            AND "appointment_id" IS NULL
            AND "admin_user_id" IS NOT NULL
        )
    ),
    CONSTRAINT "telegram_link_tokens_expiry_check" CHECK (
        "expires_at" > "created_at"
    ),
    CONSTRAINT "telegram_link_tokens_used_pair_check" CHECK (
        ("used_at" IS NULL) = ("used_by_update_id" IS NULL)
    ),
    CONSTRAINT "telegram_link_tokens_used_update_id_check" CHECK (
        "used_by_update_id" IS NULL OR "used_by_update_id" >= 0
    ),
    CONSTRAINT "telegram_link_tokens_used_revoked_check" CHECK (
        NOT ("used_at" IS NOT NULL AND "revoked_at" IS NOT NULL)
    )
);

CREATE TABLE "appointment_telegram_connections" (
    "id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "telegram_chat_id" BIGINT NOT NULL,
    "source_update_id" BIGINT NOT NULL,
    "connected_at" TIMESTAMPTZ(3) NOT NULL,
    "disabled_at" TIMESTAMPTZ(3),
    "disabled_reason" "TelegramConnectionDisabledReason",

    CONSTRAINT "appointment_telegram_connections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointment_telegram_connections_telegram_user_id_check" CHECK (
        "telegram_user_id" > 0
    ),
    CONSTRAINT "appointment_telegram_connections_telegram_chat_id_check" CHECK (
        "telegram_chat_id" > 0
    ),
    CONSTRAINT "appointment_telegram_connections_source_update_id_check" CHECK (
        "source_update_id" >= 0
    ),
    CONSTRAINT "appointment_telegram_connections_disabled_pair_check" CHECK (
        ("disabled_at" IS NULL) = ("disabled_reason" IS NULL)
    ),
    CONSTRAINT "appointment_telegram_connections_disabled_reason_check" CHECK (
        "disabled_reason" IS NULL OR "disabled_reason" <> 'ADMIN_USER_DEACTIVATED'
    )
);

CREATE TABLE "admin_telegram_connections" (
    "id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "telegram_chat_id" BIGINT NOT NULL,
    "source_update_id" BIGINT NOT NULL,
    "connected_at" TIMESTAMPTZ(3) NOT NULL,
    "disabled_at" TIMESTAMPTZ(3),
    "disabled_reason" "TelegramConnectionDisabledReason",

    CONSTRAINT "admin_telegram_connections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_telegram_connections_telegram_user_id_check" CHECK (
        "telegram_user_id" > 0
    ),
    CONSTRAINT "admin_telegram_connections_telegram_chat_id_check" CHECK (
        "telegram_chat_id" > 0
    ),
    CONSTRAINT "admin_telegram_connections_source_update_id_check" CHECK (
        "source_update_id" >= 0
    ),
    CONSTRAINT "admin_telegram_connections_disabled_pair_check" CHECK (
        ("disabled_at" IS NULL) = ("disabled_reason" IS NULL)
    )
);

CREATE TABLE "notification_outbox" (
    "id" UUID NOT NULL,
    "appointment_id" UUID,
    "appointment_connection_id" UUID,
    "admin_connection_id" UUID,
    "direct_chat_id" BIGINT,
    "recipient_kind" "NotificationRecipientKind" NOT NULL,
    "type" "NotificationType" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_token" UUID,
    "lease_owner" VARCHAR(100),
    "claimed_at" TIMESTAMPTZ(3),
    "lease_expires_at" TIMESTAMPTZ(3),
    "invalidated_at" TIMESTAMPTZ(3),
    "invalidation_code" VARCHAR(64),
    "last_error_code" VARCHAR(64),
    "payload_version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "dedupe_key" VARCHAR(255) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_outbox_recipient_check" CHECK (
        (
            "recipient_kind" = 'APPOINTMENT_CONNECTION'
            AND "appointment_connection_id" IS NOT NULL
            AND "admin_connection_id" IS NULL
            AND "direct_chat_id" IS NULL
        )
        OR (
            "recipient_kind" = 'ADMIN_CONNECTION'
            AND "appointment_connection_id" IS NULL
            AND "admin_connection_id" IS NOT NULL
            AND "direct_chat_id" IS NULL
        )
        OR (
            "recipient_kind" = 'DIRECT_CHAT'
            AND "appointment_connection_id" IS NULL
            AND "admin_connection_id" IS NULL
            AND "direct_chat_id" IS NOT NULL
        )
    ),
    CONSTRAINT "notification_outbox_type_scope_check" CHECK (
        (
            "type" IN (
                'CLIENT_CONNECTION_CONFIRMED',
                'CLIENT_APPOINTMENT_CANCELLED',
                'CLIENT_APPOINTMENT_CHANGED',
                'CLIENT_APPOINTMENT_REMINDER'
            )
            AND "recipient_kind" = 'APPOINTMENT_CONNECTION'
            AND "appointment_id" IS NOT NULL
        )
        OR (
            "type" IN (
                'ADMIN_APPOINTMENT_CREATED',
                'ADMIN_APPOINTMENT_CANCELLED'
            )
            AND "recipient_kind" = 'ADMIN_CONNECTION'
            AND "appointment_id" IS NOT NULL
        )
        OR (
            "type" = 'ADMIN_CONNECTION_CONFIRMED'
            AND "recipient_kind" = 'ADMIN_CONNECTION'
            AND "appointment_id" IS NULL
        )
        OR (
            "type" = 'TELEGRAM_CONNECTION_REJECTED'
            AND "recipient_kind" = 'DIRECT_CHAT'
            AND "appointment_id" IS NULL
        )
    ),
    CONSTRAINT "notification_outbox_direct_chat_id_check" CHECK (
        "direct_chat_id" IS NULL OR "direct_chat_id" > 0
    ),
    CONSTRAINT "notification_outbox_attempts_check" CHECK (
        "attempts" BETWEEN 0 AND 6
    ),
    CONSTRAINT "notification_outbox_payload_version_check" CHECK (
        "payload_version" > 0
    ),
    CONSTRAINT "notification_outbox_schedule_check" CHECK (
        "next_attempt_at" >= "scheduled_at"
        AND (
            "expires_at" IS NULL
            OR "next_attempt_at" <= "expires_at"
        )
    ),
    CONSTRAINT "notification_outbox_expiry_check" CHECK (
        (
            "type" = 'CLIENT_APPOINTMENT_REMINDER'
            AND "expires_at" = "scheduled_at" + INTERVAL '15 minutes'
        )
        OR (
            "type" = 'TELEGRAM_CONNECTION_REJECTED'
            AND "expires_at" = "scheduled_at" + INTERVAL '5 minutes'
        )
        OR (
            "type" NOT IN (
                'CLIENT_APPOINTMENT_REMINDER',
                'TELEGRAM_CONNECTION_REJECTED'
            )
            AND "expires_at" IS NULL
        )
    ),
    CONSTRAINT "notification_outbox_lease_check" CHECK (
        (
            "status" = 'PROCESSING'
            AND "lease_token" IS NOT NULL
            AND "lease_owner" IS NOT NULL
            AND char_length("lease_owner") > 0
            AND "claimed_at" IS NOT NULL
            AND "lease_expires_at" IS NOT NULL
            AND "lease_expires_at" > "claimed_at"
        )
        OR (
            "status" <> 'PROCESSING'
            AND "lease_token" IS NULL
            AND "lease_owner" IS NULL
            AND "claimed_at" IS NULL
            AND "lease_expires_at" IS NULL
        )
    ),
    CONSTRAINT "notification_outbox_invalidation_pair_check" CHECK (
        ("invalidated_at" IS NULL) = ("invalidation_code" IS NULL)
    ),
    CONSTRAINT "notification_outbox_invalidation_code_check" CHECK (
        "invalidation_code" IS NULL OR "invalidation_code" IN (
            'APPOINTMENT_CANCELLED',
            'APPOINTMENT_COMPLETED',
            'APPOINTMENT_NO_SHOW',
            'VISIT_CHANGED',
            'CONNECTION_DISABLED',
            'ADMIN_USER_DEACTIVATED',
            'BOT_REPLACED'
        )
    ),
    CONSTRAINT "notification_outbox_cancelled_invalidation_check" CHECK (
        "status" <> 'CANCELLED' OR "invalidated_at" IS NOT NULL
    ),
    CONSTRAINT "notification_outbox_last_error_code_check" CHECK (
        "last_error_code" IS NULL OR "last_error_code" IN (
            'NETWORK_UNREACHABLE',
            'DELIVERY_OUTCOME_UNKNOWN',
            'TELEGRAM_RATE_LIMIT',
            'TELEGRAM_5XX',
            'INVALID_REQUEST',
            'CHAT_NOT_FOUND',
            'BOT_BLOCKED',
            'CHAT_WRITE_FORBIDDEN',
            'TELEGRAM_USER_DEACTIVATED',
            'CONFIG_UNAUTHORIZED',
            'BOT_IDENTITY_MISMATCH',
            'WEBHOOK_ACTIVE',
            'RESPONSE_INVALID',
            'RESPONSE_TOO_LARGE',
            'PAYLOAD_VERSION_UNSUPPORTED',
            'REMINDER_EXPIRED',
            'CONNECTION_INACTIVE',
            'APPOINTMENT_NOT_SCHEDULED',
            'VISIT_MISMATCH'
        )
    ),
    CONSTRAINT "notification_outbox_sent_check" CHECK (
        ("status" = 'SENT') = ("sent_at" IS NOT NULL)
    ),
    CONSTRAINT "notification_outbox_terminal_check" CHECK (
        (
            "status" IN ('SENT', 'DEAD', 'CANCELLED', 'SKIPPED')
        ) = ("finished_at" IS NOT NULL)
    ),
    CONSTRAINT "notification_outbox_payload_size_check" CHECK (
        octet_length("payload"::TEXT) <= 16384
    ),
    CONSTRAINT "notification_outbox_dedupe_key_check" CHECK (
        char_length("dedupe_key") > 0
    )
);

CREATE UNIQUE INDEX "telegram_link_tokens_token_hash_key"
    ON "telegram_link_tokens"("token_hash");
CREATE UNIQUE INDEX "telegram_link_tokens_used_by_update_id_key"
    ON "telegram_link_tokens"("used_by_update_id");
CREATE INDEX "telegram_link_tokens_appointment_id_idx"
    ON "telegram_link_tokens"("appointment_id");
CREATE INDEX "telegram_link_tokens_admin_user_id_idx"
    ON "telegram_link_tokens"("admin_user_id");
CREATE INDEX "telegram_link_tokens_expires_at_idx"
    ON "telegram_link_tokens"("expires_at");
CREATE UNIQUE INDEX "telegram_link_tokens_active_appointment_key"
    ON "telegram_link_tokens"("appointment_id")
    WHERE "appointment_id" IS NOT NULL
        AND "used_at" IS NULL
        AND "revoked_at" IS NULL;
CREATE UNIQUE INDEX "telegram_link_tokens_active_admin_user_key"
    ON "telegram_link_tokens"("admin_user_id")
    WHERE "admin_user_id" IS NOT NULL
        AND "used_at" IS NULL
        AND "revoked_at" IS NULL;

CREATE UNIQUE INDEX "appointment_telegram_connections_source_update_id_key"
    ON "appointment_telegram_connections"("source_update_id");
CREATE UNIQUE INDEX "appointment_telegram_connections_id_appointment_id_key"
    ON "appointment_telegram_connections"("id", "appointment_id");
CREATE INDEX "appointment_telegram_connections_appointment_id_idx"
    ON "appointment_telegram_connections"("appointment_id");
CREATE INDEX "appointment_telegram_connections_telegram_chat_id_idx"
    ON "appointment_telegram_connections"("telegram_chat_id");
CREATE UNIQUE INDEX "appointment_telegram_connections_active_appointment_key"
    ON "appointment_telegram_connections"("appointment_id")
    WHERE "disabled_at" IS NULL;

CREATE UNIQUE INDEX "admin_telegram_connections_source_update_id_key"
    ON "admin_telegram_connections"("source_update_id");
CREATE INDEX "admin_telegram_connections_admin_user_id_idx"
    ON "admin_telegram_connections"("admin_user_id");
CREATE INDEX "admin_telegram_connections_telegram_chat_id_idx"
    ON "admin_telegram_connections"("telegram_chat_id");
CREATE UNIQUE INDEX "admin_telegram_connections_active_admin_user_key"
    ON "admin_telegram_connections"("admin_user_id")
    WHERE "disabled_at" IS NULL;
CREATE UNIQUE INDEX "admin_telegram_connections_active_chat_key"
    ON "admin_telegram_connections"("telegram_chat_id")
    WHERE "disabled_at" IS NULL;

CREATE UNIQUE INDEX "notification_outbox_dedupe_key_key"
    ON "notification_outbox"("dedupe_key");
CREATE INDEX "notification_outbox_status_next_attempt_at_id_idx"
    ON "notification_outbox"("status", "next_attempt_at", "id");
CREATE INDEX "notification_outbox_status_lease_expires_at_idx"
    ON "notification_outbox"("status", "lease_expires_at");
CREATE INDEX "notification_outbox_appointment_id_type_idx"
    ON "notification_outbox"("appointment_id", "type");
CREATE INDEX "notification_outbox_appointment_connection_id_status_idx"
    ON "notification_outbox"("appointment_connection_id", "status");
CREATE INDEX "notification_outbox_admin_connection_id_status_idx"
    ON "notification_outbox"("admin_connection_id", "status");
CREATE INDEX "notification_outbox_pending_claim_idx"
    ON "notification_outbox"("next_attempt_at", "id")
    WHERE "status" = 'PENDING';
CREATE INDEX "notification_outbox_processing_recovery_idx"
    ON "notification_outbox"("lease_expires_at", "id")
    WHERE "status" = 'PROCESSING';
CREATE INDEX "notification_outbox_appointment_connection_open_idx"
    ON "notification_outbox"("appointment_connection_id", "status")
    WHERE "appointment_connection_id" IS NOT NULL
        AND "status" IN ('PENDING', 'PROCESSING');
CREATE INDEX "notification_outbox_admin_connection_open_idx"
    ON "notification_outbox"("admin_connection_id", "status")
    WHERE "admin_connection_id" IS NOT NULL
        AND "status" IN ('PENDING', 'PROCESSING');

ALTER TABLE "telegram_link_tokens"
    ADD CONSTRAINT "telegram_link_tokens_appointment_id_fkey"
    FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telegram_link_tokens"
    ADD CONSTRAINT "telegram_link_tokens_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_telegram_connections"
    ADD CONSTRAINT "appointment_telegram_connections_appointment_id_fkey"
    FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_telegram_connections"
    ADD CONSTRAINT "admin_telegram_connections_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_outbox"
    ADD CONSTRAINT "notification_outbox_appointment_id_fkey"
    FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_outbox"
    ADD CONSTRAINT "notification_outbox_appointment_connection_id_fkey"
    FOREIGN KEY ("appointment_connection_id")
    REFERENCES "appointment_telegram_connections"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_outbox"
    ADD CONSTRAINT "notification_outbox_admin_connection_id_fkey"
    FOREIGN KEY ("admin_connection_id")
    REFERENCES "admin_telegram_connections"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_outbox"
    ADD CONSTRAINT "notification_outbox_appointment_connection_scope_fkey"
    FOREIGN KEY ("appointment_connection_id", "appointment_id")
    REFERENCES "appointment_telegram_connections"("id", "appointment_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "telegram_bot_state" (
    "id",
    "next_update_id",
    "updated_at"
) VALUES (
    1,
    0,
    CURRENT_TIMESTAMP
);

COMMIT;
