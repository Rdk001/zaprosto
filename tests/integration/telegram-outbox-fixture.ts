import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";

export const OUTBOX_NOW = new Date("2032-02-01T08:00:00.000Z");
export const owner = () => randomUUID();
export const after = (milliseconds: number) => new Date(OUTBOX_NOW.getTime() + milliseconds);

export function isolatedOutboxDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/^\/zaprosto_test_[a-f0-9]{32}$/.test(new URL(url).pathname)) {
    throw new Error("Outbox tests require the isolated PostgreSQL runner");
  }
  return url;
}

export async function createOutboxFixture(database: PrismaClient) {
  const prefix = `outbox-test-${randomUUID()}`;
  const service = await database.service.create({
    data: { name: "Outbox fixture service", priceKopecks: 3000, durationMinutes: 30 },
  });
  const master = await database.master.create({ data: { name: "Outbox fixture master" } });
  const request = await database.bookingRequest.create({ data: { idempotencyKey: prefix } });
  const appointment = await database.appointment.create({
    data: {
      masterId: master.id,
      serviceId: service.id,
      bookingRequestId: request.id,
      startsAt: after(2 * 60 * 60_000),
      endsAt: after(2.5 * 60 * 60_000),
      clientName: "Outbox fixture client",
      clientPhone: "+79990000000",
      source: "ONLINE",
      masterSelection: "SPECIFIC",
      serviceNameSnapshot: service.name,
      servicePriceSnapshot: 3000,
      serviceDurationSnapshot: 30,
      cancellationTokenHash: randomUUID(),
    },
  });
  const admin = await database.adminUser.create({
    data: {
      login: prefix,
      passwordHash: "test-only-non-credential",
    },
  });
  const externalId = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`) + 1n;
  const clientConnection = await database.appointmentTelegramConnection.create({
    data: {
      appointmentId: appointment.id,
      telegramChatId: externalId,
      telegramUserId: externalId,
      sourceUpdateId: externalId,
      connectedAt: OUTBOX_NOW,
    },
  });
  const adminConnection = await database.adminTelegramConnection.create({
    data: {
      adminUserId: admin.id,
      telegramChatId: externalId + 1n,
      telegramUserId: externalId + 1n,
      sourceUpdateId: externalId + 1n,
      connectedAt: OUTBOX_NOW,
    },
  });
  const visit = {
    serviceId: service.id,
    masterId: master.id,
    startsAt: appointment.startsAt.toISOString(),
    endsAt: appointment.endsAt.toISOString(),
    durationMinutes: 30,
  };
  const cleanupJobs = () =>
    database.notificationOutbox.deleteMany({ where: { dedupeKey: { startsWith: prefix } } });
  return {
    appointmentId: appointment.id,
    clientConnectionId: clientConnection.id,
    adminConnectionId: adminConnection.id,
    externalId,
    async seed(overrides: Partial<Prisma.NotificationOutboxUncheckedCreateInput> = {}) {
      const type = overrides.type ?? "ADMIN_CONNECTION_CONFIRMED";
      const scheduledAt = overrides.scheduledAt ?? OUTBOX_NOW;
      const recipient =
        type === "TELEGRAM_CONNECTION_REJECTED"
          ? { recipientKind: "DIRECT_CHAT" as const, directChatId: externalId + 2n }
          : type.startsWith("CLIENT_")
            ? {
                recipientKind: "APPOINTMENT_CONNECTION" as const,
                appointmentId: appointment.id,
                appointmentConnectionId: clientConnection.id,
              }
            : {
                recipientKind: "ADMIN_CONNECTION" as const,
                adminConnectionId: adminConnection.id,
                ...(type.startsWith("ADMIN_APPOINTMENT") ? { appointmentId: appointment.id } : {}),
              };
      return database.notificationOutbox.create({
        data: {
          ...recipient,
          type,
          scheduledAt,
          nextAttemptAt: scheduledAt,
          expiresAt:
            type === "TELEGRAM_CONNECTION_REJECTED" || type === "CLIENT_APPOINTMENT_REMINDER"
              ? new Date(
                  new Date(scheduledAt).getTime() +
                    (type === "TELEGRAM_CONNECTION_REJECTED" ? 5 : 15) * 60_000,
                )
              : null,
          payload:
            type === "CLIENT_APPOINTMENT_REMINDER" ? { visitVersion: 0, expectedVisit: visit } : {},
          dedupeKey: `${prefix}-${randomUUID()}`,
          ...overrides,
        },
      });
    },
    cleanupJobs,
    async cleanup() {
      await cleanupJobs();
      await database.appointmentTelegramConnection.delete({ where: { id: clientConnection.id } });
      await database.adminTelegramConnection.delete({ where: { id: adminConnection.id } });
      await database.appointment.delete({ where: { id: appointment.id } });
      await database.bookingRequest.delete({ where: { id: request.id } });
      await database.adminUser.delete({ where: { id: admin.id } });
      await database.master.delete({ where: { id: master.id } });
      await database.service.delete({ where: { id: service.id } });
    },
  };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function bounded<T>(promise: Promise<T>, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Outbox concurrency barrier timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Test-only barrier/fault after real SQL, before the real PostgreSQL COMMIT.
export function beforeCommitClient(
  database: PrismaClient,
  beforeCommit: (tx: Prisma.TransactionClient) => Promise<void>,
): PrismaClient {
  return new Proxy(database, {
    get(target, property) {
      if (property === "$transaction") {
        return (run: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
          target.$transaction(async (tx) => {
            const result = await run(tx);
            await beforeCommit(tx);
            return result;
          }, options);
      }
      return Reflect.get(target, property);
    },
  });
}
