import { randomUUID } from "node:crypto";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { hashSessionToken } from "../../src/modules/auth/server/auth-service";
import {
  prepareBookingAttempt,
  hashBookingToken,
} from "../../src/modules/booking/server/booking-security";
import { TelegramLinkRepository } from "../../src/modules/telegram/server/link-repository";
import { TelegramLinkService } from "../../src/modules/telegram/server/link-service";
import type { TelegramWebConfiguration } from "../../src/modules/telegram/domain/config-contract";

export const LINK_BOT_USERNAME = "zaprosto_test_bot";
export const LINK_CONFIGURATION: TelegramWebConfiguration = {
  kind: "ENABLED",
  botUsername: LINK_BOT_USERNAME,
};
const prefix = `telegram-link-test-${randomUUID()}`;

export function linkDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value || !/^\/zaprosto_test_[a-f0-9]{32}$/.test(new URL(value).pathname))
    throw new Error("Telegram link tests require the isolated PostgreSQL runner");
  return value;
}

export function createLinkService(database: PrismaClient) {
  return new TelegramLinkService(
    database,
    new TelegramLinkRepository(database, LINK_CONFIGURATION),
  );
}

export async function createTelegramLinkFixture(database: PrismaClient) {
  const service = await database.service.create({
    data: { name: "Telegram link fixture service", priceKopecks: 2500, durationMinutes: 30 },
  });
  const master = await database.master.create({
    data: { name: "Telegram link fixture master" },
  });
  let external = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`);

  async function appointment(
    input: {
      status?: "SCHEDULED" | "CANCELLED" | "COMPLETED" | "NO_SHOW";
      startsAt?: Date;
    } = {},
  ) {
    const token = prepareBookingAttempt().cancellationToken;
    const request = await database.bookingRequest.create({
      data: { idempotencyKey: `${prefix}-${randomUUID()}` },
    });
    const startsAt = input.startsAt ?? new Date(Date.now() + 60 * 60_000);
    const row = await database.appointment.create({
      data: {
        masterId: master.id,
        serviceId: service.id,
        bookingRequestId: request.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        clientName: "Telegram link client",
        clientPhone: "+79990000000",
        status: input.status ?? "SCHEDULED",
        source: "ONLINE",
        masterSelection: "SPECIFIC",
        serviceNameSnapshot: service.name,
        servicePriceSnapshot: service.priceKopecks,
        serviceDurationSnapshot: service.durationMinutes,
        cancellationTokenHash: hashBookingToken(token),
      },
    });
    return { ...row, token };
  }

  async function admin(
    input: {
      isActive?: boolean;
      session?: "ACTIVE" | "EXPIRED" | "REVOKED";
    } = {},
  ) {
    const row = await database.adminUser.create({
      data: {
        login: `${prefix}-${randomUUID()}`,
        passwordHash: "test-only-non-credential",
        isActive: input.isActive ?? true,
      },
    });
    const token = prepareBookingAttempt().cancellationToken;
    const session = await database.adminSession.create({
      data: {
        adminId: row.id,
        tokenHash: hashSessionToken(token),
        expiresAt:
          input.session === "EXPIRED"
            ? new Date(Date.now() - 60_000)
            : new Date(Date.now() + 60 * 60_000),
        revokedAt: input.session === "REVOKED" ? new Date() : null,
      },
    });
    return { ...row, token, sessionId: session.id };
  }

  async function clientConnection(appointmentId: string, active = true) {
    external += 3n;
    return database.appointmentTelegramConnection.create({
      data: {
        appointmentId,
        telegramUserId: external,
        telegramChatId: external,
        sourceUpdateId: external,
        connectedAt: new Date(),
        ...(active ? {} : { disabledAt: new Date(), disabledReason: "USER_DISCONNECTED" as const }),
      },
    });
  }

  async function adminConnection(adminUserId: string, active = true) {
    external += 3n;
    return database.adminTelegramConnection.create({
      data: {
        adminUserId,
        telegramUserId: external,
        telegramChatId: external,
        sourceUpdateId: external,
        connectedAt: new Date(),
        ...(active ? {} : { disabledAt: new Date(), disabledReason: "USER_DISCONNECTED" as const }),
      },
    });
  }

  async function cleanupRows() {
    await database.notificationOutbox.deleteMany({
      where: {
        OR: [
          { appointment: { serviceId: service.id } },
          { appointmentConnection: { appointment: { serviceId: service.id } } },
          { adminConnection: { adminUser: { login: { startsWith: prefix } } } },
        ],
      },
    });
    await database.telegramLinkToken.deleteMany({
      where: {
        OR: [
          { appointment: { serviceId: service.id } },
          { adminUser: { login: { startsWith: prefix } } },
        ],
      },
    });
    await database.appointmentTelegramConnection.deleteMany({
      where: { appointment: { serviceId: service.id } },
    });
    await database.adminTelegramConnection.deleteMany({
      where: { adminUser: { login: { startsWith: prefix } } },
    });
    await database.adminSession.deleteMany({
      where: { admin: { login: { startsWith: prefix } } },
    });
    await database.appointment.deleteMany({ where: { serviceId: service.id } });
    await database.bookingRequest.deleteMany({
      where: { idempotencyKey: { startsWith: prefix } },
    });
    await database.adminUser.deleteMany({ where: { login: { startsWith: prefix } } });
    await database.publicRateLimit.deleteMany({ where: { key: { startsWith: "telegram-link:" } } });
    await database.telegramBotState.update({
      where: { id: 1 },
      data: {
        botUserId: null,
        botUsername: null,
        nextUpdateId: 0n,
        lastVerifiedAt: null,
        lastPollAt: null,
        lastErrorCode: null,
      },
    });
  }

  async function readyBot() {
    await database.$executeRaw`
      UPDATE telegram_bot_state
      SET bot_user_id = 5000000001,
          bot_username = ${LINK_BOT_USERNAME},
          last_verified_at = clock_timestamp(),
          last_poll_at = clock_timestamp(),
          last_error_code = NULL
      WHERE id = 1
    `;
  }

  return {
    service,
    master,
    appointment,
    admin,
    clientConnection,
    adminConnection,
    readyBot,
    cleanupRows,
    nextExternal() {
      external += 3n;
      return external;
    },
    async cleanup() {
      await cleanupRows();
      await database.master.delete({ where: { id: master.id } });
      await database.service.delete({ where: { id: service.id } });
    },
  };
}
