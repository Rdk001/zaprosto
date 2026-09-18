import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { TelegramCleanupRepository } from "../../src/modules/telegram/server/cleanup-repository";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { isolatedOutboxDatabaseUrl } from "./telegram-outbox-fixture";

const NOW = new Date("2035-06-15T12:00:00.000Z");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const url = isolatedOutboxDatabaseUrl();
const first = createPrismaClient(url);
const second = createPrismaClient(url);
const forbiddenFetch = vi.fn(() => {
  throw new Error("Real Telegram network is forbidden");
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;
const fixtures: Fixture[] = [];

function at(milliseconds: number): Date {
  return new Date(NOW.getTime() + milliseconds);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createFixture(database: PrismaClient) {
  const prefix = `cleanup-${randomUUID()}`;
  const service = await database.service.create({
    data: { name: prefix, priceKopecks: 1000, durationMinutes: 30 },
  });
  const master = await database.master.create({ data: { name: prefix } });
  const admin = await database.adminUser.create({
    data: { login: prefix, passwordHash: "test-only" },
  });
  let sequence = 0n;
  const appointmentIds: string[] = [];

  async function appointment(
    input: {
      status?: "SCHEDULED" | "COMPLETED" | "NO_SHOW" | "CANCELLED";
      startsAt?: Date;
      endsAt?: Date;
      statusAt?: Date;
    } = {},
  ) {
    const defaultStartsAt = at(10 * DAY + appointmentIds.length * 2 * HOUR);
    const request = await database.bookingRequest.create({
      data: { idempotencyKey: `${prefix}-request-${randomUUID()}` },
    });
    const row = await database.appointment.create({
      data: {
        masterId: master.id,
        serviceId: service.id,
        bookingRequestId: request.id,
        startsAt: input.startsAt ?? defaultStartsAt,
        endsAt: input.endsAt ?? new Date(defaultStartsAt.getTime() + HOUR),
        clientName: "Cleanup fixture",
        clientPhone: "+79990000000",
        status: input.status ?? "SCHEDULED",
        source: "ONLINE",
        masterSelection: "SPECIFIC",
        serviceNameSnapshot: service.name,
        servicePriceSnapshot: 1000,
        serviceDurationSnapshot: 30,
        cancellationTokenHash: hash(`${prefix}-cancel-${randomUUID()}`),
      },
    });
    appointmentIds.push(row.id);
    if (input.status && input.status !== "SCHEDULED") {
      await database.appointmentStatusHistory.create({
        data: {
          appointmentId: row.id,
          previousStatus: "SCHEDULED",
          newStatus: input.status,
          changedAt: input.statusAt ?? NOW,
          changedBy: "SYSTEM",
        },
      });
    }
    return row;
  }

  async function clientConnection(appointmentId: string, disabledAt?: Date) {
    sequence += 1n;
    return database.appointmentTelegramConnection.create({
      data: {
        appointmentId,
        telegramUserId: 8_000_000n + sequence,
        telegramChatId: 8_000_000n + sequence,
        sourceUpdateId: 8_000_000n + sequence,
        connectedAt: at(-200 * DAY),
        ...(disabledAt ? { disabledAt, disabledReason: "USER_DISCONNECTED" as const } : {}),
      },
    });
  }

  async function adminConnection(disabledAt?: Date) {
    sequence += 1n;
    return database.adminTelegramConnection.create({
      data: {
        adminUserId: admin.id,
        telegramUserId: 9_000_000n + sequence,
        telegramChatId: 9_000_000n + sequence,
        sourceUpdateId: 9_000_000n + sequence,
        connectedAt: at(-200 * DAY),
        ...(disabledAt ? { disabledAt, disabledReason: "USER_DISCONNECTED" as const } : {}),
      },
    });
  }

  async function directOutbox(input: {
    status?: "PENDING" | "PROCESSING" | "SENT" | "DEAD" | "CANCELLED" | "SKIPPED";
    finishedAt?: Date;
  }) {
    sequence += 1n;
    const status = input.status ?? "DEAD";
    const scheduledAt = at(-200 * DAY);
    return database.notificationOutbox.create({
      data: {
        recipientKind: "DIRECT_CHAT",
        directChatId: 7_000_000n + sequence,
        type: "TELEGRAM_CONNECTION_REJECTED",
        status,
        scheduledAt,
        nextAttemptAt: scheduledAt,
        expiresAt: new Date(scheduledAt.getTime() + 5 * 60_000),
        payload: {},
        dedupeKey: `${prefix}-direct-${randomUUID()}`,
        ...(status === "PROCESSING"
          ? {
              attempts: 1,
              leaseToken: randomUUID(),
              leaseOwner: prefix,
              claimedAt: at(-HOUR),
              leaseExpiresAt: at(HOUR),
            }
          : {}),
        ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
        ...(status === "SENT" ? { sentAt: input.finishedAt } : {}),
        ...(status === "CANCELLED"
          ? {
              invalidatedAt: input.finishedAt,
              invalidationCode: "BOT_REPLACED" as const,
            }
          : {}),
      },
    });
  }

  async function connectionOutbox(input: {
    appointmentId?: string;
    appointmentConnectionId?: string;
    adminConnectionId?: string;
    finishedAt?: Date;
    status?: "PENDING" | "DEAD";
  }) {
    const scheduledAt = at(-200 * DAY);
    const status = input.status ?? "DEAD";
    return database.notificationOutbox.create({
      data: input.adminConnectionId
        ? {
            recipientKind: "ADMIN_CONNECTION",
            adminConnectionId: input.adminConnectionId,
            type: "ADMIN_CONNECTION_CONFIRMED",
            status,
            scheduledAt,
            nextAttemptAt: scheduledAt,
            payload: {},
            dedupeKey: `${prefix}-admin-${randomUUID()}`,
            ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
          }
        : {
            recipientKind: "APPOINTMENT_CONNECTION",
            appointmentId: input.appointmentId!,
            appointmentConnectionId: input.appointmentConnectionId!,
            type: "CLIENT_CONNECTION_CONFIRMED",
            status,
            scheduledAt,
            nextAttemptAt: scheduledAt,
            payload: {},
            dedupeKey: `${prefix}-client-${randomUUID()}`,
            ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
          },
    });
  }

  async function token(input: {
    appointmentId: string;
    expiresAt: Date;
    usedAt?: Date;
    revokedAt?: Date;
  }) {
    sequence += 1n;
    return database.telegramLinkToken.create({
      data: {
        purpose: "APPOINTMENT",
        tokenHash: hash(`${prefix}-token-${sequence}`),
        appointmentId: input.appointmentId,
        createdAt: at(-200 * DAY),
        expiresAt: input.expiresAt,
        ...(input.usedAt ? { usedAt: input.usedAt, usedByUpdateId: 6_000_000n + sequence } : {}),
        ...(input.revokedAt ? { revokedAt: input.revokedAt } : {}),
      },
    });
  }

  async function cleanup() {
    await database.notificationOutbox.deleteMany({
      where: { dedupeKey: { startsWith: prefix } },
    });
    await database.telegramLinkToken.deleteMany({
      where: { appointmentId: { in: appointmentIds } },
    });
    await database.appointmentTelegramConnection.deleteMany({
      where: { appointmentId: { in: appointmentIds } },
    });
    await database.adminTelegramConnection.deleteMany({ where: { adminUserId: admin.id } });
    await database.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
    await database.bookingRequest.deleteMany({
      where: { idempotencyKey: { startsWith: `${prefix}-request-` } },
    });
    await database.adminUser.delete({ where: { id: admin.id } });
    await database.master.delete({ where: { id: master.id } });
    await database.service.delete({ where: { id: service.id } });
  }

  return {
    prefix,
    appointment,
    clientConnection,
    adminConnection,
    directOutbox,
    connectionOutbox,
    token,
    cleanup,
  };
}

function deletedTotal(result: Awaited<ReturnType<TelegramCleanupRepository["run"]>>): number {
  return Object.values(result).reduce((sum, value) => sum + value, 0);
}

beforeAll(async () => {
  await Promise.all([first.$connect(), second.$connect()]);
});
beforeEach(() => {
  vi.stubGlobal("fetch", forbiddenFetch);
});
afterEach(async () => {
  expect(forbiddenFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});
afterAll(async () => {
  await Promise.all([first.$disconnect(), second.$disconnect()]);
});

describe("Telegram retention cleanup with PostgreSQL", () => {
  it("applies strict 24h/30d/90d boundaries and preserves non-terminal rows", async () => {
    const fixture = await createFixture(first);
    fixtures.push(fixture);
    const appointment = await fixture.appointment();
    const adminConnection = await fixture.adminConnection();
    const directOld = await fixture.directOutbox({ finishedAt: at(-DAY - 1) });
    const directExact = await fixture.directOutbox({ finishedAt: at(-DAY) });
    const directFresh = await fixture.directOutbox({ finishedAt: at(-DAY + 1) });
    const pending = await fixture.directOutbox({ status: "PENDING" });
    const processing = await fixture.directOutbox({ status: "PROCESSING" });
    const otherOld = await fixture.connectionOutbox({
      adminConnectionId: adminConnection.id,
      finishedAt: at(-90 * DAY - 1),
    });
    const otherExact = await fixture.connectionOutbox({
      adminConnectionId: adminConnection.id,
      finishedAt: at(-90 * DAY),
    });
    const otherFresh = await fixture.connectionOutbox({
      adminConnectionId: adminConnection.id,
      finishedAt: at(-90 * DAY + 1),
    });
    const expiredOld = await fixture.token({
      appointmentId: appointment.id,
      expiresAt: at(-30 * DAY - 1),
    });
    const expiredExactTarget = await fixture.appointment();
    const expiredExact = await fixture.token({
      appointmentId: expiredExactTarget.id,
      expiresAt: at(-30 * DAY),
    });
    const expiredFreshTarget = await fixture.appointment();
    const expiredFresh = await fixture.token({
      appointmentId: expiredFreshTarget.id,
      expiresAt: at(-30 * DAY + 1),
    });
    const usedOld = await fixture.token({
      appointmentId: appointment.id,
      expiresAt: at(DAY),
      usedAt: at(-30 * DAY - 1),
    });
    const revokedOld = await fixture.token({
      appointmentId: appointment.id,
      expiresAt: at(DAY),
      revokedAt: at(-30 * DAY - 1),
    });
    const unusedTarget = await fixture.appointment();
    const unused = await fixture.token({ appointmentId: unusedTarget.id, expiresAt: at(DAY) });

    const result = await new TelegramCleanupRepository(first).run({ batchSize: 100, now: NOW });

    expect(result).toMatchObject({
      deletedDirectRejectedOutbox: 2,
      deletedOtherOutbox: 1,
      deletedLinkTokens: 3,
    });
    expect(
      await first.notificationOutbox.findMany({
        where: {
          id: {
            in: [
              directOld.id,
              directExact.id,
              directFresh.id,
              pending.id,
              processing.id,
              otherOld.id,
              otherExact.id,
              otherFresh.id,
            ],
          },
        },
        select: { id: true },
      }),
    ).toHaveLength(5);
    expect(
      await first.telegramLinkToken.findMany({
        where: {
          id: {
            in: [
              expiredOld.id,
              expiredExact.id,
              expiredFresh.id,
              usedOld.id,
              revokedOld.id,
              unused.id,
            ],
          },
        },
        select: { id: true },
      }),
    ).toHaveLength(3);
  });

  it("enforces a total batch cap, is repeatable, and orders outbox before referenced connections", async () => {
    const fixture = await createFixture(first);
    fixtures.push(fixture);
    const appointment = await fixture.appointment();
    const connection = await fixture.clientConnection(appointment.id, at(-90 * DAY - 1));
    await fixture.connectionOutbox({
      appointmentId: appointment.id,
      appointmentConnectionId: connection.id,
      finishedAt: at(-90 * DAY - 1),
    });
    for (let index = 0; index < 3; index += 1) {
      await fixture.directOutbox({ finishedAt: at(-DAY - 1 - index) });
    }
    const cleanup = new TelegramCleanupRepository(first);

    const firstRun = await cleanup.run({ batchSize: 2, now: NOW });
    const secondRun = await cleanup.run({ batchSize: 10, now: NOW });
    const thirdRun = await cleanup.run({ batchSize: 10, now: NOW });

    expect(deletedTotal(firstRun)).toBe(2);
    expect(deletedTotal(secondRun)).toBe(3);
    expect(secondRun.deletedDisabledAppointmentConnections).toBe(1);
    expect(deletedTotal(thirdRun)).toBe(0);
    await expect(
      first.appointmentTelegramConnection.findUnique({ where: { id: connection.id } }),
    ).resolves.toBeNull();
  });

  it("removes only eligible connections and preserves references, active admins and bot state", async () => {
    const fixture = await createFixture(first);
    fixtures.push(fixture);
    const disabledAppointment = await fixture.appointment();
    const disabledClient = await fixture.clientConnection(
      disabledAppointment.id,
      at(-90 * DAY - 1),
    );
    const referencedAppointment = await fixture.appointment();
    const referencedClient = await fixture.clientConnection(
      referencedAppointment.id,
      at(-90 * DAY - 1),
    );
    await fixture.connectionOutbox({
      appointmentId: referencedAppointment.id,
      appointmentConnectionId: referencedClient.id,
      status: "PENDING",
    });
    const terminalOld = await fixture.appointment({
      status: "COMPLETED",
      statusAt: at(-90 * DAY - 1),
    });
    const terminalClient = await fixture.clientConnection(terminalOld.id);
    const terminalExact = await fixture.appointment({
      status: "NO_SHOW",
      statusAt: at(-90 * DAY),
    });
    const terminalExactClient = await fixture.clientConnection(terminalExact.id);
    const past = await fixture.appointment({
      startsAt: at(-91 * DAY),
      endsAt: at(-90 * DAY - 1),
    });
    const pastClient = await fixture.clientConnection(past.id);
    const future = await fixture.appointment();
    const activeClient = await fixture.clientConnection(future.id);
    const disabledAdmin = await fixture.adminConnection(at(-90 * DAY - 1));
    const activeAdmin = await fixture.adminConnection();
    const botStateBefore = await first.telegramBotState.findUnique({ where: { id: 1 } });

    const result = await new TelegramCleanupRepository(first).run({ batchSize: 100, now: NOW });

    expect(result).toMatchObject({
      deletedDisabledAppointmentConnections: 1,
      deletedDisabledAdminConnections: 1,
      deletedRetiredAppointmentConnections: 2,
    });
    const remainingClientIds = new Set(
      (
        await first.appointmentTelegramConnection.findMany({
          where: {
            id: {
              in: [
                disabledClient.id,
                referencedClient.id,
                terminalClient.id,
                terminalExactClient.id,
                pastClient.id,
                activeClient.id,
              ],
            },
          },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    expect(remainingClientIds).toEqual(
      new Set([referencedClient.id, terminalExactClient.id, activeClient.id]),
    );
    await expect(
      first.adminTelegramConnection.findMany({
        where: { id: { in: [disabledAdmin.id, activeAdmin.id] } },
        select: { id: true },
      }),
    ).resolves.toEqual([{ id: activeAdmin.id }]);
    await expect(first.telegramBotState.findUnique({ where: { id: 1 } })).resolves.toEqual(
      botStateBefore,
    );
  });

  it("splits concurrent runs with SKIP LOCKED and never exceeds either batch", async () => {
    const fixture = await createFixture(first);
    fixtures.push(fixture);
    for (let index = 0; index < 10; index += 1) {
      await fixture.directOutbox({ finishedAt: at(-DAY - 1 - index) });
    }

    const [left, right] = await Promise.all([
      new TelegramCleanupRepository(first).run({ batchSize: 6, now: NOW }),
      new TelegramCleanupRepository(second).run({ batchSize: 6, now: NOW }),
    ]);

    expect(deletedTotal(left)).toBeLessThanOrEqual(6);
    expect(deletedTotal(right)).toBeLessThanOrEqual(6);
    expect(deletedTotal(left) + deletedTotal(right)).toBe(10);
    expect(
      await first.notificationOutbox.count({
        where: { dedupeKey: { startsWith: `${fixture.prefix}-direct-` } },
      }),
    ).toBe(0);
  });
});
