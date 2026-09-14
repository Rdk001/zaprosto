import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { hashTelegramLinkToken } from "../../src/modules/telegram/domain/link-token";
import { AppointmentTelegramRepository } from "../../src/modules/telegram/server/appointment-connection-repository";
import { AppointmentTelegramService } from "../../src/modules/telegram/server/appointment-connection-service";
import { processTelegramStart } from "../../src/modules/telegram/server/start-processor";
import { prepareBookingAttempt } from "../../src/modules/booking/server/booking-security";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import {
  LINK_CONFIGURATION,
  createLinkService,
  createTelegramLinkFixture,
  linkDatabaseUrl,
} from "./telegram-link-fixture";
import { bounded } from "./telegram-outbox-fixture";

const url = linkDatabaseUrl();
const database = createPrismaClient(url);
const concurrentDatabase = createPrismaClient(url);
let fixture: Awaited<ReturnType<typeof createTelegramLinkFixture>>;
let external = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`) + 50_000n;
const directChats = new Set<bigint>();
const forbiddenFetch = vi.fn(() => {
  throw new Error("External Telegram network is forbidden");
});

function service(
  client: PrismaClient = database,
  options: ConstructorParameters<typeof AppointmentTelegramRepository>[2] = {},
) {
  return new AppointmentTelegramService(
    new AppointmentTelegramRepository(client, LINK_CONFIGURATION, options),
  );
}

function raw(
  result: Awaited<ReturnType<ReturnType<typeof createLinkService>["issueAppointmentLink"]>>,
) {
  if (!result.ok) throw new Error("Expected issued link");
  const value = new URL(result.deepLink).searchParams.get("start");
  if (!value) throw new Error("Expected start parameter");
  return value;
}

async function start(client: PrismaClient, startParameter: string) {
  const hashed = hashTelegramLinkToken(startParameter);
  if (!hashed.ok) throw new Error("Expected valid start parameter");
  external += 7n;
  const updateId = external;
  external += 7n;
  const chatId = external;
  directChats.add(chatId);
  return client.$transaction(
    (tx) =>
      processTelegramStart(tx, {
        updateId,
        telegramUserId: chatId,
        telegramChatId: chatId,
        purpose: "APPOINTMENT",
        tokenHash: hashed.hash,
      }),
    { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 },
  );
}

async function job(input: {
  appointmentId: string;
  connectionId: string;
  status?: "PENDING" | "PROCESSING" | "SENT";
}) {
  const now = new Date();
  const processing =
    input.status === "PROCESSING"
      ? {
          attempts: 1,
          leaseToken: randomUUID(),
          leaseOwner: "telegram-appointment-connection-test",
          claimedAt: now,
          leaseExpiresAt: new Date(now.getTime() + 60_000),
        }
      : {};
  return database.notificationOutbox.create({
    data: {
      recipientKind: "APPOINTMENT_CONNECTION",
      appointmentId: input.appointmentId,
      appointmentConnectionId: input.connectionId,
      type: "CLIENT_CONNECTION_CONFIRMED",
      status: input.status ?? "PENDING",
      scheduledAt: now,
      nextAttemptAt: now,
      payload: {},
      dedupeKey: `telegram-appointment-connection-test-${randomUUID()}`,
      sentAt: input.status === "SENT" ? now : null,
      finishedAt: input.status === "SENT" ? now : null,
      ...processing,
    },
  });
}

beforeAll(async () => {
  await Promise.all([database.$connect(), concurrentDatabase.$connect()]);
  fixture = await createTelegramLinkFixture(database);
});

beforeEach(async () => {
  vi.stubGlobal("fetch", forbiddenFetch);
  await fixture.cleanupRows();
  await fixture.readyBot();
});

afterEach(async () => {
  await database.notificationOutbox.deleteMany({
    where: { directChatId: { in: [...directChats] } },
  });
  directChats.clear();
  await fixture.cleanupRows();
  expect(forbiddenFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await fixture?.cleanup();
  await Promise.all([database.$disconnect(), concurrentDatabase.$disconnect()]);
});

describe("Appointment Telegram state and disconnect", () => {
  it("returns AVAILABLE only for a future scheduled appointment with fresh readiness", async () => {
    const appointment = await fixture.appointment();
    await expect(service().getState(appointment.token)).resolves.toEqual({
      ok: true,
      state: "AVAILABLE",
    });

    const disabled = new AppointmentTelegramService(
      new AppointmentTelegramRepository(database, { kind: "DISABLED" }),
    );
    await expect(disabled.getState(appointment.token)).resolves.toEqual({
      ok: true,
      state: "UNAVAILABLE",
    });
    await database.telegramBotState.update({
      where: { id: 1 },
      data: { lastPollAt: new Date("2000-01-01T00:00:00.000Z") },
    });
    await expect(service().getState(appointment.token)).resolves.toEqual({
      ok: true,
      state: "UNAVAILABLE",
    });
  });

  it("returns UNAVAILABLE for past and terminal appointments without an active connection", async () => {
    for (const input of [
      { startsAt: new Date(Date.now() - 60_000) },
      { status: "CANCELLED" as const, startsAt: new Date(Date.now() + 60 * 60_000) },
      { status: "COMPLETED" as const, startsAt: new Date(Date.now() + 2 * 60 * 60_000) },
      { status: "NO_SHOW" as const, startsAt: new Date(Date.now() + 3 * 60 * 60_000) },
    ]) {
      const appointment = await fixture.appointment(input);
      await expect(service().getState(appointment.token)).resolves.toEqual({
        ok: true,
        state: "UNAVAILABLE",
      });
    }
  });

  it("gives CONNECTED priority and does not reveal a wrong cancellation token", async () => {
    const appointment = await fixture.appointment({ status: "CANCELLED" });
    await fixture.clientConnection(appointment.id);
    await database.telegramBotState.update({
      where: { id: 1 },
      data: { lastErrorCode: "POLLING_CONFLICT" },
    });
    await expect(service().getState(appointment.token)).resolves.toEqual({
      ok: true,
      state: "CONNECTED",
    });
    await expect(service().getState(prepareBookingAttempt().cancellationToken)).resolves.toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("disconnects atomically, revokes unused links and invalidates only its connection jobs", async () => {
    const appointment = await fixture.appointment();
    const otherAppointment = await fixture.appointment({
      startsAt: new Date(Date.now() + 2 * 60 * 60_000),
    });
    await createLinkService(database).issueAppointmentLink(appointment.token);
    const connection = await fixture.clientConnection(appointment.id);
    const otherConnection = await fixture.clientConnection(otherAppointment.id);
    const pending = await job({ appointmentId: appointment.id, connectionId: connection.id });
    const processing = await job({
      appointmentId: appointment.id,
      connectionId: connection.id,
      status: "PROCESSING",
    });
    const sent = await job({
      appointmentId: appointment.id,
      connectionId: connection.id,
      status: "SENT",
    });
    const other = await job({
      appointmentId: otherAppointment.id,
      connectionId: otherConnection.id,
    });

    await expect(service().disconnect(appointment.token)).resolves.toEqual({
      ok: true,
      alreadyDisconnected: false,
    });
    const disabled = await database.appointmentTelegramConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(disabled.disabledAt).toBeInstanceOf(Date);
    expect(disabled.disabledReason).toBe("USER_DISCONNECTED");
    expect(
      await database.telegramLinkToken.count({
        where: {
          appointmentId: appointment.id,
          usedAt: null,
          revokedAt: null,
        },
      }),
    ).toBe(0);
    await expect(
      database.notificationOutbox.findUniqueOrThrow({ where: { id: pending.id } }),
    ).resolves.toMatchObject({ status: "CANCELLED", invalidationCode: "CONNECTION_DISABLED" });
    await expect(
      database.notificationOutbox.findUniqueOrThrow({ where: { id: processing.id } }),
    ).resolves.toMatchObject({ status: "PROCESSING", invalidationCode: "CONNECTION_DISABLED" });
    await expect(
      database.notificationOutbox.findUniqueOrThrow({ where: { id: sent.id } }),
    ).resolves.toMatchObject({ status: "SENT", invalidationCode: null });
    await expect(
      database.notificationOutbox.findUniqueOrThrow({ where: { id: other.id } }),
    ).resolves.toMatchObject({ status: "PENDING", invalidationCode: null });
  });

  it("is idempotent and preserves the first disabled timestamp", async () => {
    const appointment = await fixture.appointment();
    const connection = await fixture.clientConnection(appointment.id);
    await expect(service().disconnect(appointment.token)).resolves.toMatchObject({
      ok: true,
      alreadyDisconnected: false,
    });
    const first = await database.appointmentTelegramConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    await expect(service().disconnect(appointment.token)).resolves.toEqual({
      ok: true,
      alreadyDisconnected: true,
    });
    const second = await database.appointmentTelegramConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(second.disabledAt).toEqual(first.disabledAt);
    expect(second.disabledReason).toBe("USER_DISCONNECTED");
  });

  it("rolls back connection and token changes if outbox invalidation fails", async () => {
    const appointment = await fixture.appointment();
    await createLinkService(database).issueAppointmentLink(appointment.token);
    const connection = await fixture.clientConnection(appointment.id);
    const broken = service(database, {
      invalidateOutbox: async () => {
        throw new Error("INVALIDATION_FAULT_CANARY");
      },
    });
    const error = await broken.disconnect(appointment.token).catch((value: unknown) => value);
    expect(JSON.stringify(error)).not.toContain("CANARY");
    await expect(
      database.appointmentTelegramConnection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).resolves.toMatchObject({ disabledAt: null, disabledReason: null });
    expect(
      await database.telegramLinkToken.count({
        where: { appointmentId: appointment.id, usedAt: null, revokedAt: null },
      }),
    ).toBe(1);
  });

  it("serializes Start against revoke and disconnect without partial state", async () => {
    for (const operation of ["REVOKE", "DISCONNECT"] as const) {
      await fixture.cleanupRows();
      await fixture.readyBot();
      const appointment = await fixture.appointment();
      const links = createLinkService(database);
      const issued = await links.issueAppointmentLink(appointment.token);
      const startParameter = raw(issued);
      const [startResult] = await bounded(
        Promise.all([
          start(concurrentDatabase, startParameter),
          operation === "REVOKE"
            ? links.revokeAppointmentLink(appointment.token)
            : service().disconnect(appointment.token),
        ]),
        8_000,
      );
      expect(["CONNECTED", "REJECTED"]).toContain(startResult.kind);
      const active = await database.appointmentTelegramConnection.findMany({
        where: { appointmentId: appointment.id, disabledAt: null },
      });
      expect(active).toHaveLength(
        operation === "REVOKE" && startResult.kind === "CONNECTED" ? 1 : 0,
      );
      expect(
        await database.telegramLinkToken.count({
          where: { appointmentId: appointment.id, usedAt: null, revokedAt: null },
        }),
      ).toBe(0);
      if (operation === "DISCONNECT") {
        const connectionJobs = await database.notificationOutbox.findMany({
          where: { appointmentConnection: { appointmentId: appointment.id } },
        });
        expect(connectionJobs.every((row) => row.invalidationCode === "CONNECTION_DISABLED")).toBe(
          true,
        );
      }
    }
  });

  it("reconnects with a new immutable connection and never retargets old jobs", async () => {
    const appointment = await fixture.appointment();
    const links = createLinkService(database);
    const firstLink = raw(await links.issueAppointmentLink(appointment.token));
    expect((await start(database, firstLink)).kind).toBe("CONNECTED");
    const firstConnection = await database.appointmentTelegramConnection.findFirstOrThrow({
      where: { appointmentId: appointment.id, disabledAt: null },
    });
    await service().disconnect(appointment.token);
    const oldJobs = await database.notificationOutbox.findMany({
      where: { appointmentConnectionId: firstConnection.id },
      select: { id: true },
    });

    const secondLink = raw(await links.issueAppointmentLink(appointment.token));
    expect((await start(database, secondLink)).kind).toBe("CONNECTED");
    const connections = await database.appointmentTelegramConnection.findMany({
      where: { appointmentId: appointment.id },
      orderBy: { connectedAt: "asc" },
    });
    expect(connections).toHaveLength(2);
    expect(connections[0]!.id).toBe(firstConnection.id);
    expect(connections[0]!.disabledReason).toBe("USER_DISCONNECTED");
    expect(connections[1]!.disabledAt).toBeNull();
    for (const oldJob of oldJobs) {
      await expect(
        database.notificationOutbox.findUniqueOrThrow({ where: { id: oldJob.id } }),
      ).resolves.toMatchObject({
        appointmentConnectionId: firstConnection.id,
        invalidationCode: "CONNECTION_DISABLED",
      });
    }
  });
});
