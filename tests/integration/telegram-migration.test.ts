import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

const targetMigrationName = "20260904120000_telegram_transactional_outbox";
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.includes("/zaprosto_test_")) {
  throw new Error(
    "Telegram migration integration tests require the isolated zaprosto_test_* database",
  );
}

let legacyMigrationSql: string[];
let targetMigrationSql: string;

type LegacyFixture = {
  appointmentId: string;
  adminUserId: string;
};

async function withLegacySchema(
  run: (client: pg.Client, schemaName: string) => Promise<void>,
): Promise<void> {
  const schemaName = "telegram_migration_" + randomUUID().replaceAll("-", "");
  const client = new pg.Client({ connectionString: testDatabaseUrl });

  await client.connect();
  await client.query('CREATE SCHEMA "' + schemaName + '"');
  await client.query('SET search_path TO "' + schemaName + '", public');

  try {
    for (const sql of legacyMigrationSql) {
      await client.query(sql);
    }

    await run(client, schemaName);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("SET search_path TO public").catch(() => undefined);
    await client.query('DROP SCHEMA "' + schemaName + '" CASCADE');
    await client.end();
  }
}

async function seedLegacyBusinessRows(client: pg.Client): Promise<LegacyFixture> {
  const serviceId = randomUUID();
  const masterId = randomUUID();
  const bookingRequestId = randomUUID();
  const appointmentId = randomUUID();
  const adminUserId = randomUUID();
  const now = new Date("2031-01-01T00:00:00.000Z");

  await client.query(
    [
      'INSERT INTO "services" (',
      '  "id", "name", "price_kopecks", "duration_minutes",',
      '  "is_active", "display_order", "created_at", "updated_at"',
      ") VALUES ($1, $2, 2500, 30, TRUE, 0, $3, $3)",
    ].join("\n"),
    [serviceId, "Migration service", now],
  );
  await client.query(
    [
      'INSERT INTO "masters" (',
      '  "id", "name", "is_active", "display_order", "created_at", "updated_at"',
      ") VALUES ($1, $2, TRUE, 0, $3, $3)",
    ].join("\n"),
    [masterId, "Migration master", now],
  );
  await client.query(
    [
      'INSERT INTO "booking_requests" (',
      '  "id", "idempotency_key", "created_at"',
      ") VALUES ($1, $2, $3)",
    ].join("\n"),
    [bookingRequestId, "migration-" + randomUUID(), now],
  );
  await client.query(
    [
      'INSERT INTO "appointments" (',
      '  "id", "master_id", "service_id", "booking_request_id",',
      '  "starts_at", "ends_at", "client_name", "client_phone",',
      '  "status", "source", "master_selection", "service_name_snapshot",',
      '  "service_price_snapshot", "service_duration_snapshot",',
      '  "cancellation_token_hash", "created_at", "updated_at"',
      ") VALUES (",
      "  $1, $2, $3, $4, $5, $6, $7, $8,",
      "  'SCHEDULED', 'ONLINE', 'SPECIFIC', $9, 2500, 30, $10, $11, $11",
      ")",
    ].join("\n"),
    [
      appointmentId,
      masterId,
      serviceId,
      bookingRequestId,
      new Date("2031-02-01T09:00:00.000Z"),
      new Date("2031-02-01T09:30:00.000Z"),
      "Migration client",
      "+79990000001",
      "Migration service",
      "cancel-" + randomUUID(),
      now,
    ],
  );
  await client.query(
    [
      'INSERT INTO "admin_users" (',
      '  "id", "login", "password_hash", "is_active",',
      '  "failed_login_attempts", "created_at", "updated_at"',
      ") VALUES ($1, $2, $3, TRUE, 0, $4, $4)",
    ].join("\n"),
    [adminUserId, "migration-admin-" + randomUUID(), "test-only-hash", now],
  );

  return { appointmentId, adminUserId };
}

beforeAll(async () => {
  const migrationsDirectory = path.resolve(process.cwd(), "prisma", "migrations");
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const legacyMigrationNames = entries
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name < targetMigrationName && /^\d{14}_/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();

  legacyMigrationSql = await Promise.all(
    legacyMigrationNames.map((name) =>
      readFile(path.join(migrationsDirectory, name, "migration.sql"), "utf8"),
    ),
  );
  targetMigrationSql = await readFile(
    path.join(migrationsDirectory, targetMigrationName, "migration.sql"),
    "utf8",
  );
});

describe("Telegram transactional outbox migration", () => {
  it("migrates an empty legacy Telegram layer and preserves business rows", async () => {
    await withLegacySchema(async (client, schemaName) => {
      const fixture = await seedLegacyBusinessRows(client);

      await client.query(targetMigrationSql);

      const relations = await client.query<{
        legacy_link: string | null;
        bot_state: string | null;
        link_tokens: string | null;
        appointment_connections: string | null;
        admin_connections: string | null;
        outbox: string | null;
      }>(
        [
          "SELECT",
          "  to_regclass($1) AS legacy_link,",
          "  to_regclass($2) AS bot_state,",
          "  to_regclass($3) AS link_tokens,",
          "  to_regclass($4) AS appointment_connections,",
          "  to_regclass($5) AS admin_connections,",
          "  to_regclass($6) AS outbox",
        ].join("\n"),
        [
          schemaName + ".telegram_links",
          schemaName + ".telegram_bot_state",
          schemaName + ".telegram_link_tokens",
          schemaName + ".appointment_telegram_connections",
          schemaName + ".admin_telegram_connections",
          schemaName + ".notification_outbox",
        ],
      );

      expect(relations.rows[0]).toMatchObject({
        legacy_link: null,
        bot_state: "telegram_bot_state",
        link_tokens: "telegram_link_tokens",
        appointment_connections: "appointment_telegram_connections",
        admin_connections: "admin_telegram_connections",
        outbox: "notification_outbox",
      });

      const botState = await client.query<{
        id: number;
        next_update_id: string;
        bot_user_id: string | null;
        bot_username: string | null;
      }>('SELECT "id", "next_update_id", "bot_user_id", "bot_username" FROM "telegram_bot_state"');
      expect(botState.rows).toEqual([
        {
          id: 1,
          next_update_id: "0",
          bot_user_id: null,
          bot_username: null,
        },
      ]);

      const appointment = await client.query<{
        id: string;
        client_name: string;
        client_phone: string;
      }>('SELECT "id", "client_name", "client_phone" FROM "appointments" WHERE "id" = $1', [
        fixture.appointmentId,
      ]);
      const admin = await client.query<{ id: string; password_hash: string }>(
        'SELECT "id", "password_hash" FROM "admin_users" WHERE "id" = $1',
        [fixture.adminUserId],
      );

      expect(appointment.rows[0]).toEqual({
        id: fixture.appointmentId,
        client_name: "Migration client",
        client_phone: "+79990000001",
      });
      expect(admin.rows[0]).toEqual({
        id: fixture.adminUserId,
        password_hash: "test-only-hash",
      });
    });
  });

  it("fails before destructive DDL when telegram_links contains a row", async () => {
    await withLegacySchema(async (client, schemaName) => {
      const fixture = await seedLegacyBusinessRows(client);
      await client.query(
        [
          'INSERT INTO "telegram_links" (',
          '  "id", "appointment_id", "token_hash", "expires_at", "created_at"',
          ") VALUES ($1, $2, $3, $4, $5)",
        ].join("\n"),
        [
          randomUUID(),
          fixture.appointmentId,
          "legacy-" + randomUUID(),
          new Date("2031-01-01T01:00:00.000Z"),
          new Date("2031-01-01T00:00:00.000Z"),
        ],
      );

      await expect(client.query(targetMigrationSql)).rejects.toThrow(
        /telegram_links contains rows/,
      );
      await client.query("ROLLBACK");

      const legacyRows = await client.query<{ count: string }>(
        'SELECT count(*) FROM "telegram_links"',
      );
      const targetTable = await client.query<{ name: string | null }>(
        "SELECT to_regclass($1) AS name",
        [schemaName + ".telegram_bot_state"],
      );

      expect(legacyRows.rows[0]?.count).toBe("1");
      expect(targetTable.rows[0]?.name).toBeNull();
    });
  });

  it("fails before destructive DDL when legacy notification_outbox contains a row", async () => {
    await withLegacySchema(async (client, schemaName) => {
      const fixture = await seedLegacyBusinessRows(client);
      await client.query(
        [
          'INSERT INTO "notification_outbox" (',
          '  "id", "appointment_id", "type", "status", "scheduled_at",',
          '  "attempts", "dedupe_key", "payload", "created_at", "updated_at"',
          ") VALUES ($1, $2, 'APPOINTMENT_CREATED', 'PENDING', $3, 0, $4, $5, $3, $3)",
        ].join("\n"),
        [
          randomUUID(),
          fixture.appointmentId,
          new Date("2031-01-01T00:00:00.000Z"),
          "legacy-" + randomUUID(),
          JSON.stringify({ legacy: true }),
        ],
      );

      await expect(client.query(targetMigrationSql)).rejects.toThrow(
        /notification_outbox contains rows/,
      );
      await client.query("ROLLBACK");

      const legacyRows = await client.query<{ count: string }>(
        'SELECT count(*) FROM "notification_outbox"',
      );
      const targetTable = await client.query<{ name: string | null }>(
        "SELECT to_regclass($1) AS name",
        [schemaName + ".telegram_bot_state"],
      );

      expect(legacyRows.rows[0]?.count).toBe("1");
      expect(targetTable.rows[0]?.name).toBeNull();
    });
  });
});
