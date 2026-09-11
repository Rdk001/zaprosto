import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import {
  generateTelegramLinkToken,
  hashTelegramLinkToken,
  type TelegramLinkPurpose,
  type TelegramStartParameter,
} from "../../src/modules/telegram/domain/link-token";
import type { ParsedTelegramStart } from "../../src/modules/telegram/server/start-command-parser";
import { processTelegramStart } from "../../src/modules/telegram/server/start-processor";

const prefix = `telegram-start-test-${randomUUID()}`;

export function startDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value || !/^\/zaprosto_test_[a-f0-9]{32}$/.test(new URL(value).pathname)) {
    throw new Error("Telegram start tests require the isolated PostgreSQL runner");
  }
  return value;
}

export async function runStart(database: PrismaClient, command: ParsedTelegramStart) {
  return database.$transaction((tx) => processTelegramStart(tx, command), {
    isolationLevel: "ReadCommitted",
    maxWait: 5_000,
    timeout: 10_000,
  });
}

export async function createTelegramStartFixture(database: PrismaClient) {
  const service = await database.service.create({
    data: {
      name: "Telegram start fixture service",
      priceKopecks: 2700,
      durationMinutes: 35,
    },
  });
  const master = await database.master.create({ data: { name: "Telegram start fixture master" } });
  let external = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`) + 10_000n;
  const directChats = new Set<bigint>();

  async function now(): Promise<Date> {
    const [row] = await database.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp()::timestamptz(3) AS now
    `;
    if (!(row?.now instanceof Date)) throw new Error("Expected PostgreSQL time");
    return row.now;
  }

  async function appointment(
    input: {
      status?: "SCHEDULED" | "CANCELLED" | "COMPLETED" | "NO_SHOW";
      startsInMs?: number;
      version?: number;
      clientPhone?: string;
    } = {},
  ) {
    const at = await now();
    const startsAt = new Date(at.getTime() + (input.startsInMs ?? 3 * 60 * 60_000));
    const request = await database.bookingRequest.create({
      data: { idempotencyKey: `${prefix}-${randomUUID()}` },
    });
    return database.appointment.create({
      data: {
        version: input.version ?? 0,
        masterId: master.id,
        serviceId: service.id,
        bookingRequestId: request.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + service.durationMinutes * 60_000),
        clientName: "TELEGRAM_START_CLIENT_NAME_CANARY",
        clientPhone: input.clientPhone ?? "+79990007766",
        status: input.status ?? "SCHEDULED",
        source: "ONLINE",
        masterSelection: "SPECIFIC",
        serviceNameSnapshot: service.name,
        servicePriceSnapshot: service.priceKopecks,
        serviceDurationSnapshot: service.durationMinutes,
        cancellationTokenHash: randomUUID(),
      },
    });
  }

  async function admin(input: { isActive?: boolean } = {}) {
    return database.adminUser.create({
      data: {
        login: `${prefix}-${randomUUID()}`,
        passwordHash: "TELEGRAM_START_PASSWORD_HASH_CANARY",
        isActive: input.isActive ?? true,
      },
    });
  }

  function credential(purpose: TelegramLinkPurpose) {
    const parsed = generateTelegramLinkToken(purpose);
    const hashed = hashTelegramLinkToken(parsed.startParameter);
    if (!hashed.ok) throw new Error("Expected generated Telegram credential");
    return { raw: parsed.startParameter, hash: hashed.hash, purpose };
  }

  async function createToken(input: {
    hashPurpose: TelegramLinkPurpose;
    rowPurpose?: TelegramLinkPurpose;
    appointmentId?: string;
    adminUserId?: string;
    expiresInMs?: number;
    revoked?: boolean;
  }) {
    const value = credential(input.hashPurpose);
    const rowPurpose = input.rowPurpose ?? input.hashPurpose;
    const at = await now();
    const row = await database.telegramLinkToken.create({
      data: {
        purpose: rowPurpose,
        tokenHash: value.hash,
        ...(rowPurpose === "APPOINTMENT"
          ? { appointmentId: input.appointmentId }
          : { adminUserId: input.adminUserId }),
        createdAt: new Date(at.getTime() - 60_000),
        expiresAt: new Date(at.getTime() + (input.expiresInMs ?? 30 * 60_000)),
        revokedAt: input.revoked ? at : null,
      },
    });
    return { ...value, id: row.id };
  }

  function command(
    token: { hash: string; purpose: TelegramLinkPurpose },
    input: { updateId?: bigint; chatId?: bigint } = {},
  ): ParsedTelegramStart {
    const updateId = input.updateId ?? nextExternal();
    const chatId = input.chatId ?? nextExternal();
    directChats.add(chatId);
    return {
      updateId,
      telegramUserId: chatId,
      telegramChatId: chatId,
      purpose: token.purpose,
      tokenHash: token.hash,
    };
  }

  async function clientConnection(appointmentId: string, chatId = nextExternal()) {
    directChats.add(chatId);
    return database.appointmentTelegramConnection.create({
      data: {
        appointmentId,
        telegramUserId: chatId,
        telegramChatId: chatId,
        sourceUpdateId: nextExternal(),
        connectedAt: await now(),
      },
    });
  }

  async function adminConnection(adminUserId: string, chatId = nextExternal()) {
    directChats.add(chatId);
    return database.adminTelegramConnection.create({
      data: {
        adminUserId,
        telegramUserId: chatId,
        telegramChatId: chatId,
        sourceUpdateId: nextExternal(),
        connectedAt: await now(),
      },
    });
  }

  function nextExternal() {
    external += 7n;
    return external;
  }

  async function cleanupRows() {
    const chatIds = [...directChats];
    await database.notificationOutbox.deleteMany({
      where: {
        OR: [
          { appointment: { serviceId: service.id } },
          { appointmentConnection: { appointment: { serviceId: service.id } } },
          { adminConnection: { adminUser: { login: { startsWith: prefix } } } },
          ...(chatIds.length === 0 ? [] : [{ directChatId: { in: chatIds } }]),
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
    await database.appointment.deleteMany({ where: { serviceId: service.id } });
    await database.bookingRequest.deleteMany({
      where: { idempotencyKey: { startsWith: prefix } },
    });
    await database.adminUser.deleteMany({ where: { login: { startsWith: prefix } } });
    directChats.clear();
  }

  return {
    service,
    master,
    now,
    appointment,
    admin,
    credential,
    createToken,
    command,
    clientConnection,
    adminConnection,
    nextExternal,
    cleanupRows,
    async cleanup() {
      await cleanupRows();
      await database.master.delete({ where: { id: master.id } });
      await database.service.delete({ where: { id: service.id } });
    },
  };
}

export function failBeforeOutboxInsert(
  tx: Prisma.TransactionClient,
  insertion: number,
): Prisma.TransactionClient {
  let seen = 0;
  return new Proxy(tx, {
    get(target, property) {
      if (property !== "notificationOutbox") return Reflect.get(target, property);
      return new Proxy(target.notificationOutbox, {
        get(delegate, delegateProperty) {
          if (delegateProperty !== "create") return Reflect.get(delegate, delegateProperty);
          return (...args: unknown[]) => {
            seen += 1;
            if (seen === insertion) return Promise.reject(new Error("OUTBOX_INSERT_FAULT_CANARY"));
            return Reflect.apply(delegate.create, delegate, args);
          };
        },
      });
    },
  }) as Prisma.TransactionClient;
}

export function rawCredential(value: string): TelegramStartParameter {
  return value as TelegramStartParameter;
}
