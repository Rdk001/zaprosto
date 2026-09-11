import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import {
  buildAdminConnectionConfirmedDedupeKey,
  buildClientAppointmentReminderDedupeKey,
  buildClientConnectionConfirmedDedupeKey,
  buildTelegramConnectionRejectedDedupeKey,
} from "../../src/modules/telegram/domain/dedupe";
import type { ParsedTelegramStart } from "../../src/modules/telegram/server/start-command-parser";
import {
  processTelegramStart,
  TelegramStartProcessorError,
} from "../../src/modules/telegram/server/start-processor";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import {
  createTelegramStartFixture,
  failBeforeOutboxInsert,
  runStart,
  startDatabaseUrl,
} from "./telegram-start-fixture";

const database: PrismaClient = createPrismaClient(startDatabaseUrl());
let fixture: Awaited<ReturnType<typeof createTelegramStartFixture>>;
const forbiddenFetch = vi.fn(() => {
  throw new Error("External Telegram network is forbidden");
});

function serialized(value: unknown) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

beforeAll(async () => {
  await database.$connect();
  fixture = await createTelegramStartFixture(database);
});

beforeEach(async () => {
  vi.stubGlobal("fetch", forbiddenFetch);
  await fixture.cleanupRows();
});

afterEach(async () => {
  await fixture.cleanupRows();
  expect(forbiddenFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await fixture?.cleanup();
  await database.$disconnect();
});

async function expectNeutralRejection(command: ParsedTelegramStart) {
  const outcome = await runStart(database, command);
  expect(outcome).toEqual({ kind: "REJECTED" });
  const job = await database.notificationOutbox.findUniqueOrThrow({
    where: { dedupeKey: buildTelegramConnectionRejectedDedupeKey({ updateId: command.updateId }) },
  });
  expect(job).toMatchObject({
    recipientKind: "DIRECT_CHAT",
    directChatId: command.telegramChatId,
    appointmentId: null,
    appointmentConnectionId: null,
    adminConnectionId: null,
    type: "TELEGRAM_CONNECTION_REJECTED",
    status: "PENDING",
    scheduledAt: job.nextAttemptAt,
    payloadVersion: 1,
    payload: {},
    attempts: 0,
  });
  expect(job.expiresAt?.getTime()).toBe(job.scheduledAt.getTime() + 5 * 60_000);
  return { outcome, job };
}

describe("transactional Telegram /start processing", () => {
  it("connects an appointment and atomically creates confirmation and reminder jobs", async () => {
    const phoneCanary = "+79998887766";
    const appointment = await fixture.appointment({
      startsInMs: 3 * 60 * 60_000,
      version: 4,
      clientPhone: phoneCanary,
    });
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    const command = fixture.command(token);
    const before = await fixture.now();
    const outcome = await runStart(database, command);
    const after = await fixture.now();

    expect(outcome).toEqual({ kind: "CONNECTED" });
    const connection = await database.appointmentTelegramConnection.findUniqueOrThrow({
      where: { sourceUpdateId: command.updateId },
    });
    expect(connection).toMatchObject({
      appointmentId: appointment.id,
      telegramUserId: command.telegramUserId,
      telegramChatId: command.telegramChatId,
      sourceUpdateId: command.updateId,
      disabledAt: null,
      disabledReason: null,
    });
    expect(connection.connectedAt >= before).toBe(true);
    expect(connection.connectedAt <= after).toBe(true);
    const used = await database.telegramLinkToken.findUniqueOrThrow({ where: { id: token.id } });
    expect(used.usedAt).toEqual(connection.connectedAt);
    expect(used.usedByUpdateId).toBe(command.updateId);

    const jobs = await database.notificationOutbox.findMany({
      where: { appointmentConnectionId: connection.id },
      orderBy: { scheduledAt: "asc" },
    });
    expect(jobs).toHaveLength(2);
    const confirmation = jobs.find((job) => job.type === "CLIENT_CONNECTION_CONFIRMED")!;
    const reminder = jobs.find((job) => job.type === "CLIENT_APPOINTMENT_REMINDER")!;
    expect(confirmation).toMatchObject({
      recipientKind: "APPOINTMENT_CONNECTION",
      appointmentId: appointment.id,
      appointmentConnectionId: connection.id,
      adminConnectionId: null,
      directChatId: null,
      status: "PENDING",
      scheduledAt: connection.connectedAt,
      nextAttemptAt: connection.connectedAt,
      expiresAt: null,
      payloadVersion: 1,
      payload: {},
      dedupeKey: buildClientConnectionConfirmedDedupeKey({
        appointmentConnectionId: connection.id,
      }),
    });
    const reminderAt = appointment.startsAt.getTime() - 2 * 60 * 60_000;
    expect(reminder).toMatchObject({
      recipientKind: "APPOINTMENT_CONNECTION",
      appointmentId: appointment.id,
      appointmentConnectionId: connection.id,
      adminConnectionId: null,
      directChatId: null,
      status: "PENDING",
      scheduledAt: new Date(reminderAt),
      nextAttemptAt: new Date(reminderAt),
      expiresAt: new Date(reminderAt + 15 * 60_000),
      payloadVersion: 1,
      payload: {
        visitVersion: 4,
        expectedVisit: {
          serviceId: appointment.serviceId,
          masterId: appointment.masterId,
          startsAt: appointment.startsAt.toISOString(),
          endsAt: appointment.endsAt.toISOString(),
          durationMinutes: appointment.serviceDurationSnapshot,
        },
      },
      dedupeKey: buildClientAppointmentReminderDedupeKey({
        appointmentId: appointment.id,
        visitVersion: 4,
        appointmentConnectionId: connection.id,
      }),
    });

    const exposed = serialized({ outcome, connection, jobs });
    for (const secret of [token.raw, token.hash, phoneCanary, appointment.clientName]) {
      expect(exposed).not.toContain(secret);
      expect(
        serialized(jobs.map((job) => ({ payload: job.payload, key: job.dedupeKey }))),
      ).not.toContain(secret);
    }
  });

  it.each([
    ["captured PostgreSQL two-hour upper bound", 2 * 60 * 60_000],
    ["less than two hours", 90 * 60_000],
  ])("does not create a reminder at %s", async (_label, startsInMs) => {
    const appointment = await fixture.appointment({ startsInMs });
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    expect(await runStart(database, fixture.command(token))).toEqual({ kind: "CONNECTED" });
    expect(
      await database.notificationOutbox.count({
        where: { appointmentId: appointment.id, type: "CLIENT_APPOINTMENT_REMINDER" },
      }),
    ).toBe(0);
  });

  it("connects an active admin and creates only the admin confirmation", async () => {
    const admin = await fixture.admin();
    const token = await fixture.createToken({ hashPurpose: "ADMIN_USER", adminUserId: admin.id });
    const command = fixture.command(token);
    expect(await runStart(database, command)).toEqual({ kind: "CONNECTED" });
    const connection = await database.adminTelegramConnection.findUniqueOrThrow({
      where: { sourceUpdateId: command.updateId },
    });
    expect(connection).toMatchObject({
      adminUserId: admin.id,
      telegramUserId: command.telegramUserId,
      telegramChatId: command.telegramChatId,
      sourceUpdateId: command.updateId,
    });
    const jobs = await database.notificationOutbox.findMany({
      where: { adminConnectionId: connection.id },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      recipientKind: "ADMIN_CONNECTION",
      appointmentId: null,
      appointmentConnectionId: null,
      adminConnectionId: connection.id,
      directChatId: null,
      type: "ADMIN_CONNECTION_CONFIRMED",
      status: "PENDING",
      scheduledAt: connection.connectedAt,
      nextAttemptAt: connection.connectedAt,
      expiresAt: null,
      payloadVersion: 1,
      payload: {},
      dedupeKey: buildAdminConnectionConfirmedDedupeKey({ adminConnectionId: connection.id }),
    });
  });

  it("uses one neutral rejection for an unknown hash", async () => {
    const command = fixture.command(fixture.credential("APPOINTMENT"));
    await expectNeutralRejection(command);
  });

  it.each([
    ["expired", { expiresInMs: -1_000 }],
    ["revoked", { revoked: true }],
  ] as const)("uses the same neutral rejection for a %s token", async (_label, tokenState) => {
    const appointment = await fixture.appointment();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
      ...tokenState,
    });
    await expectNeutralRejection(fixture.command(token));
  });

  it("rejects a hash stored under the wrong purpose without target details", async () => {
    const admin = await fixture.admin();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      rowPurpose: "ADMIN_USER",
      adminUserId: admin.id,
    });
    await expectNeutralRejection(fixture.command(token));
  });

  it.each(["CANCELLED", "COMPLETED", "NO_SHOW"] as const)(
    "rejects an appointment with status %s",
    async (status) => {
      const appointment = await fixture.appointment({ status });
      const token = await fixture.createToken({
        hashPurpose: "APPOINTMENT",
        appointmentId: appointment.id,
      });
      await expectNeutralRejection(fixture.command(token));
    },
  );

  it("rejects a past scheduled appointment", async () => {
    const appointment = await fixture.appointment({ startsInMs: -2 * 60 * 60_000 });
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    await expectNeutralRejection(fixture.command(token));
  });

  it("rejects an inactive AdminUser", async () => {
    const admin = await fixture.admin({ isActive: false });
    const token = await fixture.createToken({ hashPurpose: "ADMIN_USER", adminUserId: admin.id });
    await expectNeutralRejection(fixture.command(token));
  });

  it("rejects an appointment that already has an active connection", async () => {
    const appointment = await fixture.appointment();
    await fixture.clientConnection(appointment.id);
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    await expectNeutralRejection(fixture.command(token));
  });

  it("rejects an AdminUser that already has an active connection", async () => {
    const admin = await fixture.admin();
    await fixture.adminConnection(admin.id);
    const token = await fixture.createToken({ hashPurpose: "ADMIN_USER", adminUserId: admin.id });
    await expectNeutralRejection(fixture.command(token));
  });

  it("rejects an admin chat owned by another active AdminUser", async () => {
    const owner = await fixture.admin();
    const candidate = await fixture.admin();
    const sharedChat = fixture.nextExternal();
    await fixture.adminConnection(owner.id, sharedChat);
    const token = await fixture.createToken({
      hashPurpose: "ADMIN_USER",
      adminUserId: candidate.id,
    });
    await expectNeutralRejection(fixture.command(token, { chatId: sharedChat }));
  });

  it("allows one client chat to connect to different appointments", async () => {
    const sharedChat = fixture.nextExternal();
    const first = await fixture.appointment();
    const second = await fixture.appointment({ startsInMs: 4 * 60 * 60_000 });
    const firstToken = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: first.id,
    });
    const secondToken = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: second.id,
    });
    expect(await runStart(database, fixture.command(firstToken, { chatId: sharedChat }))).toEqual({
      kind: "CONNECTED",
    });
    expect(await runStart(database, fixture.command(secondToken, { chatId: sharedChat }))).toEqual({
      kind: "CONNECTED",
    });
    expect(
      await database.appointmentTelegramConnection.count({
        where: { telegramChatId: sharedChat, disabledAt: null },
      }),
    ).toBe(2);
  });

  it("treats a replay of the same successful updateId as already processed", async () => {
    const appointment = await fixture.appointment();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    const command = fixture.command(token);
    expect(await runStart(database, command)).toEqual({ kind: "CONNECTED" });
    expect(await runStart(database, command)).toEqual({ kind: "ALREADY_PROCESSED" });
    expect(
      await database.appointmentTelegramConnection.count({
        where: { appointmentId: appointment.id },
      }),
    ).toBe(1);
    expect(
      await database.notificationOutbox.count({ where: { appointmentId: appointment.id } }),
    ).toBe(2);
  });

  it("treats the used token from the same chat as idempotent with a new updateId", async () => {
    const appointment = await fixture.appointment();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    const first = fixture.command(token);
    expect(await runStart(database, first)).toEqual({ kind: "CONNECTED" });
    expect(
      await runStart(database, fixture.command(token, { chatId: first.telegramChatId })),
    ).toEqual({ kind: "ALREADY_PROCESSED" });
    expect(
      await database.appointmentTelegramConnection.count({
        where: { appointmentId: appointment.id },
      }),
    ).toBe(1);
  });

  it("rejects the used token from a different chat without changing immutable identity", async () => {
    const appointment = await fixture.appointment();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    const first = fixture.command(token);
    expect(await runStart(database, first)).toEqual({ kind: "CONNECTED" });
    const second = fixture.command(token);
    await expectNeutralRejection(second);
    const connection = await database.appointmentTelegramConnection.findFirstOrThrow({
      where: { appointmentId: appointment.id },
    });
    expect(connection.telegramChatId).toBe(first.telegramChatId);
    expect(connection.sourceUpdateId).toBe(first.updateId);
  });

  it("deduplicates a repeated neutral rejection for the same updateId", async () => {
    const command = fixture.command(fixture.credential("ADMIN_USER"));
    await expectNeutralRejection(command);
    expect(await runStart(database, command)).toEqual({ kind: "ALREADY_PROCESSED" });
    expect(
      await database.notificationOutbox.count({
        where: {
          dedupeKey: buildTelegramConnectionRejectedDedupeKey({ updateId: command.updateId }),
        },
      }),
    ).toBe(1);
  });

  it("rolls back connection, token use and an earlier job when a later outbox insert fails", async () => {
    const appointment = await fixture.appointment({ startsInMs: 3 * 60 * 60_000 });
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    const command = fixture.command(token);
    const error = await database
      .$transaction((tx) => processTelegramStart(failBeforeOutboxInsert(tx, 2), command))
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TelegramStartProcessorError);
    expect(error).toMatchObject({ code: "START_PROCESSOR_STORAGE_FAILURE" });
    expect(serialized(error)).not.toContain("OUTBOX_INSERT_FAULT_CANARY");
    expect(
      await database.appointmentTelegramConnection.count({
        where: { appointmentId: appointment.id },
      }),
    ).toBe(0);
    expect(
      await database.notificationOutbox.count({ where: { appointmentId: appointment.id } }),
    ).toBe(0);
    expect(
      await database.telegramLinkToken.findUniqueOrThrow({ where: { id: token.id } }),
    ).toMatchObject({
      usedAt: null,
      usedByUpdateId: null,
    });
  });

  it("leaves no effects when the caller rolls back its outer transaction", async () => {
    const appointment = await fixture.appointment();
    const token = await fixture.createToken({
      hashPurpose: "APPOINTMENT",
      appointmentId: appointment.id,
    });
    const command = fixture.command(token);
    await expect(
      database.$transaction(async (tx) => {
        expect(await processTelegramStart(tx, command)).toEqual({ kind: "CONNECTED" });
        throw new Error("CALLER_ROLLBACK_CANARY");
      }),
    ).rejects.toThrow("CALLER_ROLLBACK_CANARY");
    expect(
      await database.appointmentTelegramConnection.count({
        where: { appointmentId: appointment.id },
      }),
    ).toBe(0);
    expect(
      await database.notificationOutbox.count({ where: { appointmentId: appointment.id } }),
    ).toBe(0);
    expect(
      await database.telegramLinkToken.findUniqueOrThrow({ where: { id: token.id } }),
    ).toMatchObject({
      usedAt: null,
      usedByUpdateId: null,
    });
  });
});
