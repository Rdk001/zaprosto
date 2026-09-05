import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.includes("/zaprosto_test_")) {
  throw new Error(
    "Telegram data-model integration tests require the isolated zaprosto_test_* database",
  );
}

const database = new pg.Client({ connectionString: testDatabaseUrl });
const timestamp = new Date("2032-01-01T00:00:00.000Z");
let externalId = 10_000n;
let savepointId = 0;

type Fixture = {
  appointmentId: string;
  secondAppointmentId: string;
  adminUserId: string;
  secondAdminUserId: string;
};

type TokenInput = {
  purpose: "APPOINTMENT" | "ADMIN_USER";
  appointmentId?: string | null;
  adminUserId?: string | null;
  tokenHash?: string;
  expiresAt?: Date;
  usedAt?: Date | null;
  usedByUpdateId?: bigint | null;
  revokedAt?: Date | null;
  createdAt?: Date;
};

type ConnectionInput = {
  appointmentId: string;
  telegramUserId?: bigint;
  telegramChatId?: bigint;
  sourceUpdateId?: bigint;
  disabledAt?: Date | null;
  disabledReason?: string | null;
};

type AdminConnectionInput = {
  adminUserId: string;
  telegramUserId?: bigint;
  telegramChatId?: bigint;
  sourceUpdateId?: bigint;
  disabledAt?: Date | null;
  disabledReason?: string | null;
};

type OutboxInput = {
  appointmentId?: string | null;
  appointmentConnectionId?: string | null;
  adminConnectionId?: string | null;
  directChatId?: bigint | null;
  recipientKind: "APPOINTMENT_CONNECTION" | "ADMIN_CONNECTION" | "DIRECT_CHAT";
  type:
    | "CLIENT_CONNECTION_CONFIRMED"
    | "ADMIN_CONNECTION_CONFIRMED"
    | "TELEGRAM_CONNECTION_REJECTED"
    | "CLIENT_APPOINTMENT_CANCELLED"
    | "CLIENT_APPOINTMENT_CHANGED"
    | "CLIENT_APPOINTMENT_REMINDER"
    | "ADMIN_APPOINTMENT_CREATED"
    | "ADMIN_APPOINTMENT_CANCELLED";
  status?: "PENDING" | "PROCESSING" | "SENT" | "DEAD" | "CANCELLED" | "SKIPPED";
  scheduledAt?: Date;
  nextAttemptAt?: Date;
  expiresAt?: Date | null;
  attempts?: number;
  leaseToken?: string | null;
  leaseOwner?: string | null;
  claimedAt?: Date | null;
  leaseExpiresAt?: Date | null;
  invalidatedAt?: Date | null;
  invalidationCode?: string | null;
  lastErrorCode?: string | null;
  payloadVersion?: number;
  payload?: unknown;
  dedupeKey?: string;
  sentAt?: Date | null;
  finishedAt?: Date | null;
};

function nextExternalId(): bigint {
  const value = externalId;
  externalId += 1n;
  return value;
}

function sha256Hex(): string {
  return randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
}

function databaseErrorDetails(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const record = error as Error & {
    code?: string;
    constraint?: string;
    detail?: string;
  };

  return [record.message, record.code, record.constraint, record.detail].filter(Boolean).join(" ");
}

async function expectConstraint(
  action: () => Promise<unknown>,
  expectedConstraint: string,
): Promise<void> {
  savepointId += 1;
  const savepoint = "telegram_constraint_" + savepointId;
  await database.query('SAVEPOINT "' + savepoint + '"');

  let rejection: unknown = null;
  try {
    await action();
  } catch (error) {
    rejection = error;
  }

  await database.query('ROLLBACK TO SAVEPOINT "' + savepoint + '"');
  await database.query('RELEASE SAVEPOINT "' + savepoint + '"');

  const details = databaseErrorDetails(rejection);
  expect(rejection, "The invalid database write unexpectedly succeeded").not.toBeNull();
  expect(details).toContain(expectedConstraint);
}

async function seedFixture(): Promise<Fixture> {
  const serviceId = randomUUID();
  const masterId = randomUUID();
  const appointmentId = randomUUID();
  const secondAppointmentId = randomUUID();
  const bookingRequestId = randomUUID();
  const secondBookingRequestId = randomUUID();
  const adminUserId = randomUUID();
  const secondAdminUserId = randomUUID();

  await database.query(
    [
      'INSERT INTO "services" (',
      '  "id", "name", "price_kopecks", "duration_minutes",',
      '  "is_active", "display_order", "created_at", "updated_at"',
      ") VALUES ($1, 'Telegram test service', 3000, 30, TRUE, 0, $2, $2)",
    ].join("\n"),
    [serviceId, timestamp],
  );
  await database.query(
    [
      'INSERT INTO "masters" (',
      '  "id", "name", "is_active", "display_order", "created_at", "updated_at"',
      ") VALUES ($1, 'Telegram test master', TRUE, 0, $2, $2)",
    ].join("\n"),
    [masterId, timestamp],
  );
  await database.query(
    [
      'INSERT INTO "booking_requests" ("id", "idempotency_key", "created_at")',
      "VALUES ($1, $2, $3), ($4, $5, $3)",
    ].join("\n"),
    [
      bookingRequestId,
      "telegram-booking-" + randomUUID(),
      timestamp,
      secondBookingRequestId,
      "telegram-booking-" + randomUUID(),
    ],
  );
  await database.query(
    [
      'INSERT INTO "appointments" (',
      '  "id", "master_id", "service_id", "booking_request_id",',
      '  "starts_at", "ends_at", "client_name", "client_phone",',
      '  "status", "source", "master_selection", "service_name_snapshot",',
      '  "service_price_snapshot", "service_duration_snapshot",',
      '  "cancellation_token_hash", "created_at", "updated_at"',
      ") VALUES (",
      "  $1, $2, $3, $4, $5, $6, 'Telegram client one', '+79990000001',",
      "  'SCHEDULED', 'ONLINE', 'SPECIFIC', 'Telegram test service',",
      "  3000, 30, $7, $8, $8",
      "), (",
      "  $9, $2, $3, $10, $11, $12, 'Telegram client two', '+79990000002',",
      "  'SCHEDULED', 'ONLINE', 'SPECIFIC', 'Telegram test service',",
      "  3000, 30, $13, $8, $8",
      ")",
    ].join("\n"),
    [
      appointmentId,
      masterId,
      serviceId,
      bookingRequestId,
      new Date("2032-02-01T09:00:00.000Z"),
      new Date("2032-02-01T09:30:00.000Z"),
      "cancel-" + randomUUID(),
      timestamp,
      secondAppointmentId,
      secondBookingRequestId,
      new Date("2032-02-01T10:00:00.000Z"),
      new Date("2032-02-01T10:30:00.000Z"),
      "cancel-" + randomUUID(),
    ],
  );
  await database.query(
    [
      'INSERT INTO "admin_users" (',
      '  "id", "login", "password_hash", "is_active",',
      '  "failed_login_attempts", "created_at", "updated_at"',
      ") VALUES",
      "  ($1, $2, 'test-only-hash', TRUE, 0, $3, $3),",
      "  ($4, $5, 'test-only-hash', TRUE, 0, $3, $3)",
    ].join("\n"),
    [
      adminUserId,
      "telegram-admin-" + randomUUID(),
      timestamp,
      secondAdminUserId,
      "telegram-admin-" + randomUUID(),
    ],
  );

  return { appointmentId, secondAppointmentId, adminUserId, secondAdminUserId };
}

async function insertToken(input: TokenInput): Promise<string> {
  const id = randomUUID();
  const createdAt = input.createdAt ?? timestamp;
  await database.query(
    [
      'INSERT INTO "telegram_link_tokens" (',
      '  "id", "purpose", "token_hash", "appointment_id", "admin_user_id",',
      '  "expires_at", "used_at", "used_by_update_id", "revoked_at", "created_at"',
      ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    ].join("\n"),
    [
      id,
      input.purpose,
      input.tokenHash ?? sha256Hex(),
      input.appointmentId ?? null,
      input.adminUserId ?? null,
      input.expiresAt ?? new Date(createdAt.getTime() + 30 * 60_000),
      input.usedAt ?? null,
      input.usedByUpdateId ?? null,
      input.revokedAt ?? null,
      createdAt,
    ],
  );
  return id;
}

async function insertAppointmentConnection(input: ConnectionInput): Promise<string> {
  const id = randomUUID();
  await database.query(
    [
      'INSERT INTO "appointment_telegram_connections" (',
      '  "id", "appointment_id", "telegram_user_id", "telegram_chat_id",',
      '  "source_update_id", "connected_at", "disabled_at", "disabled_reason"',
      ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    ].join("\n"),
    [
      id,
      input.appointmentId,
      input.telegramUserId ?? nextExternalId(),
      input.telegramChatId ?? nextExternalId(),
      input.sourceUpdateId ?? nextExternalId(),
      timestamp,
      input.disabledAt ?? null,
      input.disabledReason ?? null,
    ],
  );
  return id;
}

async function insertAdminConnection(input: AdminConnectionInput): Promise<string> {
  const id = randomUUID();
  await database.query(
    [
      'INSERT INTO "admin_telegram_connections" (',
      '  "id", "admin_user_id", "telegram_user_id", "telegram_chat_id",',
      '  "source_update_id", "connected_at", "disabled_at", "disabled_reason"',
      ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    ].join("\n"),
    [
      id,
      input.adminUserId,
      input.telegramUserId ?? nextExternalId(),
      input.telegramChatId ?? nextExternalId(),
      input.sourceUpdateId ?? nextExternalId(),
      timestamp,
      input.disabledAt ?? null,
      input.disabledReason ?? null,
    ],
  );
  return id;
}

async function insertOutbox(input: OutboxInput): Promise<string> {
  const id = randomUUID();
  const scheduledAt = input.scheduledAt ?? new Date("2032-02-01T08:00:00.000Z");
  let expiresAt: Date | null;

  if (Object.prototype.hasOwnProperty.call(input, "expiresAt")) {
    expiresAt = input.expiresAt ?? null;
  } else if (input.type === "CLIENT_APPOINTMENT_REMINDER") {
    expiresAt = new Date(scheduledAt.getTime() + 15 * 60_000);
  } else if (input.type === "TELEGRAM_CONNECTION_REJECTED") {
    expiresAt = new Date(scheduledAt.getTime() + 5 * 60_000);
  } else {
    expiresAt = null;
  }

  await database.query(
    [
      'INSERT INTO "notification_outbox" (',
      '  "id", "appointment_id", "appointment_connection_id",',
      '  "admin_connection_id", "direct_chat_id", "recipient_kind",',
      '  "type", "status", "scheduled_at", "next_attempt_at", "expires_at",',
      '  "attempts", "lease_token", "lease_owner", "claimed_at",',
      '  "lease_expires_at", "invalidated_at", "invalidation_code",',
      '  "last_error_code", "payload_version", "payload", "dedupe_key",',
      '  "sent_at", "finished_at", "updated_at"',
      ") VALUES (",
      "  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,",
      "  $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22, $23, $24, $25",
      ")",
    ].join("\n"),
    [
      id,
      input.appointmentId ?? null,
      input.appointmentConnectionId ?? null,
      input.adminConnectionId ?? null,
      input.directChatId ?? null,
      input.recipientKind,
      input.type,
      input.status ?? "PENDING",
      scheduledAt,
      input.nextAttemptAt ?? scheduledAt,
      expiresAt,
      input.attempts ?? 0,
      input.leaseToken ?? null,
      input.leaseOwner ?? null,
      input.claimedAt ?? null,
      input.leaseExpiresAt ?? null,
      input.invalidatedAt ?? null,
      input.invalidationCode ?? null,
      input.lastErrorCode ?? null,
      input.payloadVersion ?? 1,
      JSON.stringify(input.payload ?? { test: true }),
      input.dedupeKey ?? "telegram-job-" + randomUUID(),
      input.sentAt ?? null,
      input.finishedAt ?? null,
      timestamp,
    ],
  );
  return id;
}

beforeAll(async () => {
  await database.connect();
});

beforeEach(async () => {
  await database.query("BEGIN");
});

afterEach(async () => {
  await database.query("ROLLBACK");
});

afterAll(async () => {
  await database.end();
});

describe("Telegram data model constraints", () => {
  it("creates the singleton and every approved Telegram/outbox model and type", async () => {
    const fixture = await seedFixture();
    const botState = await database.query<{
      id: number;
      next_update_id: string;
      bot_user_id: string | null;
      bot_username: string | null;
    }>('SELECT "id", "next_update_id", "bot_user_id", "bot_username" FROM "telegram_bot_state"');
    expect(botState.rows).toEqual([
      { id: 1, next_update_id: "0", bot_user_id: null, bot_username: null },
    ]);

    await database.query(
      [
        'UPDATE "telegram_bot_state"',
        'SET "bot_user_id" = $1, "bot_username" = $2, "updated_at" = $3',
        'WHERE "id" = 1',
      ].join("\n"),
      [nextExternalId(), "zaprosto_test_bot", timestamp],
    );

    await insertToken({
      purpose: "APPOINTMENT",
      appointmentId: fixture.appointmentId,
    });
    await insertToken({ purpose: "ADMIN_USER", adminUserId: fixture.adminUserId });
    const appointmentConnectionId = await insertAppointmentConnection({
      appointmentId: fixture.appointmentId,
    });
    const adminConnectionId = await insertAdminConnection({
      adminUserId: fixture.adminUserId,
    });

    const clientTypes: OutboxInput["type"][] = [
      "CLIENT_CONNECTION_CONFIRMED",
      "CLIENT_APPOINTMENT_CANCELLED",
      "CLIENT_APPOINTMENT_CHANGED",
      "CLIENT_APPOINTMENT_REMINDER",
    ];
    for (const type of clientTypes) {
      await insertOutbox({
        appointmentId: fixture.appointmentId,
        appointmentConnectionId,
        recipientKind: "APPOINTMENT_CONNECTION",
        type,
      });
    }

    for (const type of ["ADMIN_APPOINTMENT_CREATED", "ADMIN_APPOINTMENT_CANCELLED"] as const) {
      await insertOutbox({
        appointmentId: fixture.appointmentId,
        adminConnectionId,
        recipientKind: "ADMIN_CONNECTION",
        type,
      });
    }

    await insertOutbox({
      adminConnectionId,
      recipientKind: "ADMIN_CONNECTION",
      type: "ADMIN_CONNECTION_CONFIRMED",
    });
    await insertOutbox({
      directChatId: nextExternalId(),
      recipientKind: "DIRECT_CHAT",
      type: "TELEGRAM_CONNECTION_REJECTED",
    });

    const counts = await database.query<{
      tokens: string;
      appointment_connections: string;
      admin_connections: string;
      jobs: string;
    }>(
      [
        "SELECT",
        '  (SELECT count(*) FROM "telegram_link_tokens") AS tokens,',
        '  (SELECT count(*) FROM "appointment_telegram_connections") AS appointment_connections,',
        '  (SELECT count(*) FROM "admin_telegram_connections") AS admin_connections,',
        '  (SELECT count(*) FROM "notification_outbox") AS jobs',
      ].join("\n"),
    );
    expect(counts.rows[0]).toEqual({
      tokens: "2",
      appointment_connections: "1",
      admin_connections: "1",
      jobs: "8",
    });
  });

  it("rejects invalid singleton, token target, lifetime, and consumption states", async () => {
    const fixture = await seedFixture();

    await expectConstraint(
      () =>
        database.query(
          'INSERT INTO "telegram_bot_state" ("id", "next_update_id", "updated_at") VALUES (2, 0, $1)',
          [timestamp],
        ),
      "telegram_bot_state_singleton_check",
    );
    await expectConstraint(
      () => database.query('UPDATE "telegram_bot_state" SET "next_update_id" = -1 WHERE "id" = 1'),
      "telegram_bot_state_next_update_id_check",
    );
    await expectConstraint(
      () =>
        database.query(
          'UPDATE "telegram_bot_state" SET "bot_user_id" = 42, "bot_username" = NULL WHERE "id" = 1',
        ),
      "telegram_bot_state_identity_pair_check",
    );
    await expectConstraint(
      () =>
        database.query(
          'UPDATE "telegram_bot_state" SET "bot_user_id" = -1, "bot_username" = $1 WHERE "id" = 1',
          ["zaprosto_test_bot"],
        ),
      "telegram_bot_state_bot_user_id_check",
    );

    await expectConstraint(
      () =>
        insertToken({
          purpose: "APPOINTMENT",
          adminUserId: fixture.adminUserId,
        }),
      "telegram_link_tokens_purpose_target_check",
    );
    await expectConstraint(
      () => insertToken({ purpose: "APPOINTMENT" }),
      "telegram_link_tokens_purpose_target_check",
    );
    await expectConstraint(
      () =>
        insertToken({
          purpose: "APPOINTMENT",
          appointmentId: fixture.appointmentId,
          tokenHash: "A".repeat(64),
        }),
      "telegram_link_tokens_token_hash_check",
    );
    await expectConstraint(
      () =>
        insertToken({
          purpose: "APPOINTMENT",
          appointmentId: fixture.appointmentId,
          expiresAt: new Date(timestamp.getTime() - 1),
        }),
      "telegram_link_tokens_expiry_check",
    );
    await expectConstraint(
      () =>
        insertToken({
          purpose: "APPOINTMENT",
          appointmentId: fixture.appointmentId,
          usedAt: timestamp,
        }),
      "telegram_link_tokens_used_pair_check",
    );
    await expectConstraint(
      () =>
        insertToken({
          purpose: "APPOINTMENT",
          appointmentId: fixture.appointmentId,
          usedAt: timestamp,
          usedByUpdateId: nextExternalId(),
          revokedAt: timestamp,
        }),
      "telegram_link_tokens_used_revoked_check",
    );
  });

  it("allows only one active token per Appointment or AdminUser", async () => {
    const fixture = await seedFixture();
    const appointmentTokenId = await insertToken({
      purpose: "APPOINTMENT",
      appointmentId: fixture.appointmentId,
    });
    await expectConstraint(
      () =>
        insertToken({
          purpose: "APPOINTMENT",
          appointmentId: fixture.appointmentId,
        }),
      "telegram_link_tokens_active_appointment_key",
    );
    await database.query('UPDATE "telegram_link_tokens" SET "revoked_at" = $1 WHERE "id" = $2', [
      timestamp,
      appointmentTokenId,
    ]);
    await insertToken({
      purpose: "APPOINTMENT",
      appointmentId: fixture.appointmentId,
    });

    const adminTokenId = await insertToken({
      purpose: "ADMIN_USER",
      adminUserId: fixture.adminUserId,
    });
    await expectConstraint(
      () => insertToken({ purpose: "ADMIN_USER", adminUserId: fixture.adminUserId }),
      "telegram_link_tokens_active_admin_user_key",
    );
    await database.query('UPDATE "telegram_link_tokens" SET "revoked_at" = $1 WHERE "id" = $2', [
      timestamp,
      adminTokenId,
    ]);
    await insertToken({ purpose: "ADMIN_USER", adminUserId: fixture.adminUserId });
  });

  it("enforces unique token hashes, consumed updates, and connection source updates", async () => {
    const fixture = await seedFixture();
    const tokenHash = sha256Hex();
    const usedByUpdateId = nextExternalId();
    const appointmentSourceUpdateId = nextExternalId();
    const adminSourceUpdateId = nextExternalId();

    await insertToken({
      purpose: "APPOINTMENT",
      appointmentId: fixture.appointmentId,
      tokenHash,
    });
    await expectConstraint(
      () =>
        insertToken({
          purpose: "APPOINTMENT",
          appointmentId: fixture.secondAppointmentId,
          tokenHash,
        }),
      "telegram_link_tokens_token_hash_key",
    );

    await insertToken({
      purpose: "APPOINTMENT",
      appointmentId: fixture.appointmentId,
      usedAt: timestamp,
      usedByUpdateId,
    });
    await expectConstraint(
      () =>
        insertToken({
          purpose: "APPOINTMENT",
          appointmentId: fixture.secondAppointmentId,
          usedAt: timestamp,
          usedByUpdateId,
        }),
      "telegram_link_tokens_used_by_update_id_key",
    );

    await insertAppointmentConnection({
      appointmentId: fixture.appointmentId,
      sourceUpdateId: appointmentSourceUpdateId,
    });
    await expectConstraint(
      () =>
        insertAppointmentConnection({
          appointmentId: fixture.secondAppointmentId,
          sourceUpdateId: appointmentSourceUpdateId,
        }),
      "appointment_telegram_connections_source_update_id_key",
    );

    await insertAdminConnection({
      adminUserId: fixture.adminUserId,
      sourceUpdateId: adminSourceUpdateId,
    });
    await expectConstraint(
      () =>
        insertAdminConnection({
          adminUserId: fixture.secondAdminUserId,
          sourceUpdateId: adminSourceUpdateId,
        }),
      "admin_telegram_connections_source_update_id_key",
    );
  });

  it("rejects invalid Telegram IDs, source updates, and disabled-state pairs", async () => {
    const fixture = await seedFixture();

    await expectConstraint(
      () =>
        insertAppointmentConnection({
          appointmentId: fixture.appointmentId,
          telegramUserId: 0n,
        }),
      "appointment_telegram_connections_telegram_user_id_check",
    );
    await expectConstraint(
      () =>
        insertAppointmentConnection({
          appointmentId: fixture.appointmentId,
          telegramChatId: 0n,
        }),
      "appointment_telegram_connections_telegram_chat_id_check",
    );
    await expectConstraint(
      () =>
        insertAppointmentConnection({
          appointmentId: fixture.appointmentId,
          sourceUpdateId: -1n,
        }),
      "appointment_telegram_connections_source_update_id_check",
    );
    await expectConstraint(
      () =>
        insertAppointmentConnection({
          appointmentId: fixture.appointmentId,
          disabledAt: timestamp,
        }),
      "appointment_telegram_connections_disabled_pair_check",
    );
    await expectConstraint(
      () =>
        insertAppointmentConnection({
          appointmentId: fixture.appointmentId,
          disabledAt: timestamp,
          disabledReason: "ADMIN_USER_DEACTIVATED",
        }),
      "appointment_telegram_connections_disabled_reason_check",
    );

    await expectConstraint(
      () =>
        insertAdminConnection({
          adminUserId: fixture.adminUserId,
          telegramUserId: 0n,
        }),
      "admin_telegram_connections_telegram_user_id_check",
    );
    await expectConstraint(
      () =>
        insertAdminConnection({
          adminUserId: fixture.adminUserId,
          telegramChatId: 0n,
        }),
      "admin_telegram_connections_telegram_chat_id_check",
    );
    await expectConstraint(
      () =>
        insertAdminConnection({
          adminUserId: fixture.adminUserId,
          sourceUpdateId: -1n,
        }),
      "admin_telegram_connections_source_update_id_check",
    );
    await expectConstraint(
      () =>
        insertAdminConnection({
          adminUserId: fixture.adminUserId,
          disabledReason: "USER_DISCONNECTED",
        }),
      "admin_telegram_connections_disabled_pair_check",
    );
  });

  it("allows only one active client connection for an Appointment", async () => {
    const fixture = await seedFixture();
    await insertAppointmentConnection({ appointmentId: fixture.appointmentId });

    await expectConstraint(
      () => insertAppointmentConnection({ appointmentId: fixture.appointmentId }),
      "appointment_telegram_connections_active_appointment_key",
    );
  });

  it("allows only one active admin connection for an AdminUser or chat", async () => {
    const fixture = await seedFixture();
    const chatId = nextExternalId();
    await insertAdminConnection({
      adminUserId: fixture.adminUserId,
      telegramChatId: chatId,
    });

    await expectConstraint(
      () =>
        insertAdminConnection({
          adminUserId: fixture.adminUserId,
          telegramChatId: nextExternalId(),
        }),
      "admin_telegram_connections_active_admin_user_key",
    );
    await expectConstraint(
      () =>
        insertAdminConnection({
          adminUserId: fixture.secondAdminUserId,
          telegramChatId: chatId,
        }),
      "admin_telegram_connections_active_chat_key",
    );
  });

  it("preserves disabled connection history while allowing replacement connections", async () => {
    const fixture = await seedFixture();
    const appointmentChatId = nextExternalId();
    const adminChatId = nextExternalId();

    await insertAppointmentConnection({
      appointmentId: fixture.appointmentId,
      telegramChatId: appointmentChatId,
      disabledAt: timestamp,
      disabledReason: "USER_DISCONNECTED",
    });
    await insertAppointmentConnection({
      appointmentId: fixture.appointmentId,
      telegramChatId: appointmentChatId,
    });
    await insertAdminConnection({
      adminUserId: fixture.adminUserId,
      telegramChatId: adminChatId,
      disabledAt: timestamp,
      disabledReason: "ADMIN_USER_DEACTIVATED",
    });
    await insertAdminConnection({
      adminUserId: fixture.adminUserId,
      telegramChatId: adminChatId,
    });

    const history = await database.query<{
      appointment_rows: string;
      disabled_appointment_rows: string;
      admin_rows: string;
      disabled_admin_rows: string;
    }>(
      [
        "SELECT",
        '  (SELECT count(*) FROM "appointment_telegram_connections") AS appointment_rows,',
        '  (SELECT count(*) FROM "appointment_telegram_connections"',
        "    WHERE \"disabled_reason\" = 'USER_DISCONNECTED') AS disabled_appointment_rows,",
        '  (SELECT count(*) FROM "admin_telegram_connections") AS admin_rows,',
        '  (SELECT count(*) FROM "admin_telegram_connections"',
        "    WHERE \"disabled_reason\" = 'ADMIN_USER_DEACTIVATED') AS disabled_admin_rows",
      ].join("\n"),
    );
    expect(history.rows[0]).toEqual({
      appointment_rows: "2",
      disabled_appointment_rows: "1",
      admin_rows: "2",
      disabled_admin_rows: "1",
    });
  });

  it("rejects inconsistent recipient fields, kinds, and notification types", async () => {
    const fixture = await seedFixture();
    const appointmentConnectionId = await insertAppointmentConnection({
      appointmentId: fixture.appointmentId,
    });
    const adminConnectionId = await insertAdminConnection({
      adminUserId: fixture.adminUserId,
    });

    await expectConstraint(
      () =>
        insertOutbox({
          appointmentId: fixture.appointmentId,
          appointmentConnectionId,
          recipientKind: "ADMIN_CONNECTION",
          type: "ADMIN_APPOINTMENT_CREATED",
        }),
      "notification_outbox_recipient_check",
    );
    await expectConstraint(
      () =>
        insertOutbox({
          directChatId: nextExternalId(),
          recipientKind: "DIRECT_CHAT",
          type: "ADMIN_CONNECTION_CONFIRMED",
        }),
      "notification_outbox_type_scope_check",
    );
    await expectConstraint(
      () =>
        insertOutbox({
          appointmentConnectionId,
          recipientKind: "APPOINTMENT_CONNECTION",
          type: "CLIENT_CONNECTION_CONFIRMED",
        }),
      "notification_outbox_type_scope_check",
    );
    await expectConstraint(
      () =>
        insertOutbox({
          adminConnectionId,
          recipientKind: "ADMIN_CONNECTION",
          type: "ADMIN_APPOINTMENT_CREATED",
        }),
      "notification_outbox_type_scope_check",
    );
    await expectConstraint(
      () =>
        insertOutbox({
          appointmentId: fixture.appointmentId,
          directChatId: nextExternalId(),
          recipientKind: "DIRECT_CHAT",
          type: "TELEGRAM_CONNECTION_REJECTED",
        }),
      "notification_outbox_type_scope_check",
    );
  });

  it("rejects a client job whose connection belongs to another Appointment", async () => {
    const fixture = await seedFixture();
    const appointmentConnectionId = await insertAppointmentConnection({
      appointmentId: fixture.appointmentId,
    });

    await expectConstraint(
      () =>
        insertOutbox({
          appointmentId: fixture.secondAppointmentId,
          appointmentConnectionId,
          recipientKind: "APPOINTMENT_CONNECTION",
          type: "CLIENT_APPOINTMENT_CHANGED",
        }),
      "notification_outbox_appointment_connection_scope_fkey",
    );
  });

  it("enforces lease groups and terminal timestamps while allowing valid states", async () => {
    const fixture = await seedFixture();
    const appointmentConnectionId = await insertAppointmentConnection({
      appointmentId: fixture.appointmentId,
    });
    const base: Pick<
      OutboxInput,
      "appointmentId" | "appointmentConnectionId" | "recipientKind" | "type"
    > = {
      appointmentId: fixture.appointmentId,
      appointmentConnectionId,
      recipientKind: "APPOINTMENT_CONNECTION",
      type: "CLIENT_CONNECTION_CONFIRMED",
    };
    const claimedAt = new Date("2032-02-01T08:01:00.000Z");
    const leaseExpiresAt = new Date("2032-02-01T08:02:00.000Z");

    await expectConstraint(
      () => insertOutbox({ ...base, status: "PROCESSING" }),
      "notification_outbox_lease_check",
    );
    await expectConstraint(
      () =>
        insertOutbox({
          ...base,
          leaseToken: randomUUID(),
          leaseOwner: "telegram-worker-test",
          claimedAt,
          leaseExpiresAt,
        }),
      "notification_outbox_lease_check",
    );
    await expectConstraint(
      () =>
        insertOutbox({
          ...base,
          status: "PROCESSING",
          leaseToken: randomUUID(),
          leaseOwner: "telegram-worker-test",
          claimedAt,
          leaseExpiresAt: claimedAt,
        }),
      "notification_outbox_lease_check",
    );
    await expectConstraint(
      () => insertOutbox({ ...base, status: "SENT", finishedAt: timestamp }),
      "notification_outbox_sent_check",
    );
    await expectConstraint(
      () => insertOutbox({ ...base, status: "PENDING", finishedAt: timestamp }),
      "notification_outbox_terminal_check",
    );
    await expectConstraint(
      () =>
        insertOutbox({
          ...base,
          status: "DEAD",
          finishedAt: timestamp,
          leaseToken: randomUUID(),
          leaseOwner: "telegram-worker-test",
          claimedAt,
          leaseExpiresAt,
        }),
      "notification_outbox_lease_check",
    );

    await insertOutbox({
      ...base,
      status: "PROCESSING",
      attempts: 1,
      leaseToken: randomUUID(),
      leaseOwner: "telegram-worker-test",
      claimedAt,
      leaseExpiresAt,
    });
    await insertOutbox({
      ...base,
      status: "SENT",
      attempts: 1,
      sentAt: timestamp,
      finishedAt: timestamp,
    });
  });

  it("enforces outbox bounds, schedules, expiry rules, and safe diagnostic codes", async () => {
    const fixture = await seedFixture();
    const adminConnectionId = await insertAdminConnection({
      adminUserId: fixture.adminUserId,
    });
    const scheduledAt = new Date("2032-02-01T08:00:00.000Z");
    const directBase: Pick<OutboxInput, "directChatId" | "recipientKind" | "type"> = {
      directChatId: nextExternalId(),
      recipientKind: "DIRECT_CHAT",
      type: "TELEGRAM_CONNECTION_REJECTED",
    };

    await expectConstraint(
      () => insertOutbox({ ...directBase, directChatId: -1n }),
      "notification_outbox_direct_chat_id_check",
    );
    await expectConstraint(
      () => insertOutbox({ ...directBase, attempts: -1 }),
      "notification_outbox_attempts_check",
    );
    await expectConstraint(
      () => insertOutbox({ ...directBase, attempts: 7 }),
      "notification_outbox_attempts_check",
    );
    await expectConstraint(
      () => insertOutbox({ ...directBase, payloadVersion: 0 }),
      "notification_outbox_payload_version_check",
    );
    await expectConstraint(
      () =>
        insertOutbox({
          ...directBase,
          scheduledAt,
          nextAttemptAt: new Date(scheduledAt.getTime() - 1),
        }),
      "notification_outbox_schedule_check",
    );
    await expectConstraint(
      () =>
        insertOutbox({
          ...directBase,
          scheduledAt,
          nextAttemptAt: new Date(scheduledAt.getTime() + 6 * 60_000),
        }),
      "notification_outbox_schedule_check",
    );
    await expectConstraint(
      () =>
        insertOutbox({
          ...directBase,
          scheduledAt,
          expiresAt: new Date(scheduledAt.getTime() + 4 * 60_000),
        }),
      "notification_outbox_expiry_check",
    );
    await expectConstraint(
      () =>
        insertOutbox({
          adminConnectionId,
          recipientKind: "ADMIN_CONNECTION",
          type: "ADMIN_CONNECTION_CONFIRMED",
          expiresAt: new Date(scheduledAt.getTime() + 5 * 60_000),
        }),
      "notification_outbox_expiry_check",
    );
    await expectConstraint(
      () => insertOutbox({ ...directBase, invalidatedAt: timestamp }),
      "notification_outbox_invalidation_pair_check",
    );
    await expectConstraint(
      () =>
        insertOutbox({
          ...directBase,
          status: "CANCELLED",
          invalidatedAt: timestamp,
          invalidationCode: "UNSAFE_FREE_FORM_REASON",
          finishedAt: timestamp,
        }),
      "notification_outbox_invalidation_code_check",
    );
    await expectConstraint(
      () => insertOutbox({ ...directBase, lastErrorCode: "raw Telegram response" }),
      "notification_outbox_last_error_code_check",
    );

    for (const code of ["POLL_OFFSET_CONFLICT", "POLLING_CONFLICT"] as const) {
      await database.query(
        'UPDATE "telegram_bot_state" SET "last_error_code" = $1 WHERE "id" = 1',
        [code],
      );
      const botState = await database.query<{ last_error_code: string | null }>(
        'SELECT "last_error_code" FROM "telegram_bot_state" WHERE "id" = 1',
      );
      expect(botState.rows[0]?.last_error_code).toBe(code);

      await expectConstraint(
        () =>
          insertOutbox({
            ...directBase,
            directChatId: nextExternalId(),
            lastErrorCode: code,
          }),
        "notification_outbox_last_error_code_check",
      );
    }

    await expectConstraint(
      () =>
        database.query('UPDATE "telegram_bot_state" SET "last_error_code" = $1 WHERE "id" = 1', [
          "raw readiness response",
        ]),
      "telegram_bot_state_last_error_code_check",
    );
  });

  it("rejects payloads over 16 KiB and duplicate dedupe keys", async () => {
    const dedupeKey = "telegram-duplicate-" + randomUUID();
    const base: Pick<OutboxInput, "directChatId" | "recipientKind" | "type"> = {
      directChatId: nextExternalId(),
      recipientKind: "DIRECT_CHAT",
      type: "TELEGRAM_CONNECTION_REJECTED",
    };

    await expectConstraint(
      () => insertOutbox({ ...base, payload: { text: "x".repeat(17_000) } }),
      "notification_outbox_payload_size_check",
    );

    await insertOutbox({ ...base, dedupeKey });
    await expectConstraint(
      () =>
        insertOutbox({
          ...base,
          directChatId: nextExternalId(),
          dedupeKey,
        }),
      "notification_outbox_dedupe_key_key",
    );
  });

  it("uses the approved foreign keys with ON DELETE RESTRICT", async () => {
    const fixture = await seedFixture();
    const expectedForeignKeys = [
      "admin_telegram_connections_admin_user_id_fkey",
      "appointment_telegram_connections_appointment_id_fkey",
      "notification_outbox_admin_connection_id_fkey",
      "notification_outbox_appointment_connection_id_fkey",
      "notification_outbox_appointment_connection_scope_fkey",
      "notification_outbox_appointment_id_fkey",
      "telegram_link_tokens_admin_user_id_fkey",
      "telegram_link_tokens_appointment_id_fkey",
    ].sort();
    const foreignKeys = await database.query<{
      conname: string;
      confdeltype: string;
    }>(
      [
        'SELECT "conname", "confdeltype"',
        "FROM pg_constraint",
        "WHERE connamespace = current_schema()::regnamespace",
        "  AND conname = ANY($1::text[])",
        'ORDER BY "conname"',
      ].join("\n"),
      [expectedForeignKeys],
    );

    expect(foreignKeys.rows.map(({ conname }) => conname)).toEqual(expectedForeignKeys);
    expect(foreignKeys.rows.every(({ confdeltype }) => confdeltype === "r")).toBe(true);

    await expectConstraint(
      () =>
        insertToken({
          purpose: "APPOINTMENT",
          appointmentId: randomUUID(),
        }),
      "telegram_link_tokens_appointment_id_fkey",
    );

    await insertToken({
      purpose: "APPOINTMENT",
      appointmentId: fixture.appointmentId,
    });
    await expectConstraint(
      () => database.query('DELETE FROM "appointments" WHERE "id" = $1', [fixture.appointmentId]),
      "telegram_link_tokens_appointment_id_fkey",
    );

    await insertToken({ purpose: "ADMIN_USER", adminUserId: fixture.adminUserId });
    await expectConstraint(
      () => database.query('DELETE FROM "admin_users" WHERE "id" = $1', [fixture.adminUserId]),
      "telegram_link_tokens_admin_user_id_fkey",
    );

    const appointmentConnectionId = await insertAppointmentConnection({
      appointmentId: fixture.secondAppointmentId,
    });
    await insertOutbox({
      appointmentId: fixture.secondAppointmentId,
      appointmentConnectionId,
      recipientKind: "APPOINTMENT_CONNECTION",
      type: "CLIENT_CONNECTION_CONFIRMED",
    });
    await expectConstraint(
      () =>
        database.query('DELETE FROM "appointment_telegram_connections" WHERE "id" = $1', [
          appointmentConnectionId,
        ]),
      "notification_outbox_appointment_connection_id_fkey",
    );

    const adminConnectionId = await insertAdminConnection({
      adminUserId: fixture.secondAdminUserId,
    });
    await insertOutbox({
      adminConnectionId,
      recipientKind: "ADMIN_CONNECTION",
      type: "ADMIN_CONNECTION_CONFIRMED",
    });
    await expectConstraint(
      () =>
        database.query('DELETE FROM "admin_telegram_connections" WHERE "id" = $1', [
          adminConnectionId,
        ]),
      "notification_outbox_admin_connection_id_fkey",
    );
  });

  it("creates the required partial claim, recovery, invalidation, and active-row indexes", async () => {
    const expectedIndexNames = [
      "admin_telegram_connections_active_admin_user_key",
      "admin_telegram_connections_active_chat_key",
      "appointment_telegram_connections_active_appointment_key",
      "notification_outbox_admin_connection_open_idx",
      "notification_outbox_appointment_connection_open_idx",
      "notification_outbox_pending_claim_idx",
      "notification_outbox_processing_recovery_idx",
      "telegram_link_tokens_active_admin_user_key",
      "telegram_link_tokens_active_appointment_key",
    ].sort();
    const indexes = await database.query<{
      indexname: string;
      indexdef: string;
    }>(
      [
        "SELECT indexname, indexdef",
        "FROM pg_indexes",
        "WHERE schemaname = current_schema()",
        "  AND indexname = ANY($1::text[])",
        "ORDER BY indexname",
      ].join("\n"),
      [expectedIndexNames],
    );
    const definitions = new Map(
      indexes.rows.map(({ indexname, indexdef }) => [
        indexname,
        indexdef.replaceAll('"', "").replace(/\s+/g, " ").toLowerCase(),
      ]),
    );

    expect([...definitions.keys()]).toEqual(expectedIndexNames);
    for (const indexName of expectedIndexNames) {
      expect(definitions.get(indexName)).toContain(" where ");
    }

    expect(definitions.get("notification_outbox_pending_claim_idx")).toMatch(
      /\(next_attempt_at, id\).*status.*pending/,
    );
    expect(definitions.get("notification_outbox_processing_recovery_idx")).toMatch(
      /\(lease_expires_at, id\).*status.*processing/,
    );
    expect(definitions.get("notification_outbox_appointment_connection_open_idx")).toMatch(
      /appointment_connection_id.*status.*pending.*processing/,
    );
    expect(definitions.get("notification_outbox_admin_connection_open_idx")).toMatch(
      /admin_connection_id.*status.*pending.*processing/,
    );

    for (const indexName of expectedIndexNames.filter((name) => name.includes("active_"))) {
      expect(definitions.get(indexName)).toMatch(/^create unique index /);
    }
  });
});
