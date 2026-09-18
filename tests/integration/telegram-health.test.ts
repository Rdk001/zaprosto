import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";
import {
  TelegramHealthSnapshotRepository,
  type TelegramHealthSnapshot,
} from "../../src/modules/telegram/server/health-snapshot";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { createOutboxFixture, isolatedOutboxDatabaseUrl } from "./telegram-outbox-fixture";

const database = createPrismaClient(isolatedOutboxDatabaseUrl());
const forbiddenFetch = vi.fn(() => {
  throw new Error("Real Telegram network is forbidden");
});
const fixtures: Awaited<ReturnType<typeof createOutboxFixture>>[] = [];

async function setReadyState(client: PrismaClient) {
  await client.$executeRaw`
    UPDATE telegram_bot_state
    SET bot_user_id = 42,
        bot_username = 'zaprosto_test_bot',
        last_verified_at = clock_timestamp(),
        last_poll_at = clock_timestamp(),
        last_error_code = NULL
    WHERE id = 1
  `;
}

async function resetState(client: PrismaClient) {
  await client.$executeRaw`
    UPDATE telegram_bot_state
    SET bot_user_id = NULL,
        bot_username = NULL,
        next_update_id = 0,
        last_verified_at = NULL,
        last_poll_at = NULL,
        last_error_code = NULL
    WHERE id = 1
  `;
}

beforeAll(async () => database.$connect());
beforeEach(() => vi.stubGlobal("fetch", forbiddenFetch));
afterEach(async () => {
  expect(forbiddenFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  await resetState(database);
});
afterAll(async () => database.$disconnect());

describe("Telegram health snapshot with PostgreSQL", () => {
  it("aggregates queue/runtime signals at one database time without PII or network", async () => {
    const fixture = await createOutboxFixture(database);
    fixtures.push(fixture);
    await setReadyState(database);
    const [clock] = await database.$queryRaw<{ now: Date }[]>(
      Prisma.sql`SELECT clock_timestamp()::timestamptz(3) AS now`,
    );
    const now = clock!.now;
    const due = new Date(now.getTime() - 5 * 60_000 - 5_000);
    const expiredClaim = new Date(now.getTime() - 60_000);
    const sentScheduled = new Date(now.getTime() - 10_000);
    const sentAt = new Date(sentScheduled.getTime() + 1_500);
    const deadAt = new Date(now.getTime() - 2_000);

    await fixture.seed({
      type: "ADMIN_CONNECTION_CONFIRMED",
      status: "PENDING",
      scheduledAt: due,
      nextAttemptAt: due,
    });
    await fixture.seed({
      type: "ADMIN_CONNECTION_CONFIRMED",
      status: "PROCESSING",
      attempts: 1,
      leaseToken: "11111111-1111-4111-8111-111111111111",
      leaseOwner: "22222222-2222-4222-8222-222222222222",
      claimedAt: new Date(expiredClaim.getTime() - 60_000),
      leaseExpiresAt: expiredClaim,
    });
    await fixture.seed({
      type: "ADMIN_APPOINTMENT_CREATED",
      status: "DEAD",
      attempts: 3,
      finishedAt: deadAt,
      lastErrorCode: "INVALID_REQUEST",
    });
    await fixture.seed({
      type: "ADMIN_CONNECTION_CONFIRMED",
      status: "SENT",
      attempts: 2,
      scheduledAt: sentScheduled,
      nextAttemptAt: sentScheduled,
      sentAt,
      finishedAt: sentAt,
    });
    await fixture.seed({
      type: "CLIENT_APPOINTMENT_REMINDER",
      status: "SKIPPED",
      attempts: 1,
      scheduledAt: new Date(now.getTime() - 20 * 60_000),
      nextAttemptAt: new Date(now.getTime() - 20 * 60_000),
      expiresAt: new Date(now.getTime() - 5 * 60_000),
      finishedAt: new Date(now.getTime() - 4 * 60_000),
      lastErrorCode: "REMINDER_EXPIRED",
    });
    await fixture.seed({
      type: "ADMIN_CONNECTION_CONFIRMED",
      status: "PENDING",
      attempts: 2,
      scheduledAt: now,
      nextAttemptAt: new Date(now.getTime() + 60_000),
      lastErrorCode: "TELEGRAM_RATE_LIMIT",
    });

    const snapshot: TelegramHealthSnapshot = await new TelegramHealthSnapshotRepository(
      database,
    ).getSnapshot({
      kind: "ENABLED",
      botUsername: "zaprosto_test_bot",
    });

    expect(snapshot.status).toBe("DEGRADED");
    expect(snapshot.readiness.polling.status).toBe("READY");
    expect(snapshot.readiness.delivery.status).toBe("READY");
    expect(snapshot.queue.dueQueueStale).toBe(true);
    expect(snapshot.queue.expiredLeases).toBe(1);
    expect(snapshot.queue.skippedClientReminders).toBe(1);
    expect(snapshot.queue.byNotificationType.ADMIN_CONNECTION_CONFIRMED).toEqual({
      pending: 2,
      processing: 1,
      dead: 0,
    });
    expect(snapshot.queue.byNotificationType.ADMIN_APPOINTMENT_CREATED.dead).toBe(1);
    expect(snapshot.queue.byNotificationType.CLIENT_APPOINTMENT_CHANGED).toEqual({
      pending: 0,
      processing: 0,
      dead: 0,
    });
    expect(snapshot.queue.newestDeadAt).toBe(deadAt.toISOString());
    expect(snapshot.deliveryMetrics).toEqual({
      sentJobs: 1,
      additionalAttemptClaims: 4,
      jobsWithLastRateLimitCode: 1,
      confirmedSendLatencyMs: { sampleSize: 1, average: 1_500, maximum: 1_500 },
    });

    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      fixture.externalId.toString(),
      fixture.appointmentId,
      "payload",
      "telegramChatId",
      "botUserId",
      "botUsername",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
