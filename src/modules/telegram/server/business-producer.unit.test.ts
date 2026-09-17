import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "../../../generated/prisma/client";
import {
  buildAdminAppointmentCancelledDedupeKey,
  buildAdminAppointmentCreatedDedupeKey,
  buildClientAppointmentCancelledDedupeKey,
} from "../domain/dedupe";
import { parseTelegramPayloadV1 } from "../domain/payload-v1";
import {
  adminAppointmentCreatedSource,
  buildVisitSnapshotV1,
  invalidateAppointmentReminderForTerminalStatus,
  produceAdminAppointmentCreated,
  produceAppointmentCancelled,
  TelegramBusinessProducerError,
  type AdminAppointmentCreatedProducerInput,
} from "./business-producer";

const APPOINTMENT_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const MASTER_ID = "33333333-3333-4333-8333-333333333333";
const FIRST_CONNECTION_ID = "44444444-4444-4444-8444-444444444444";
const SECOND_CONNECTION_ID = "55555555-5555-4555-8555-555555555555";
const CLIENT_CONNECTION_ID = "66666666-6666-4666-8666-666666666666";
const OCCURRED_AT = new Date("2026-09-16T10:11:12.345Z");

function input(
  overrides: Partial<AdminAppointmentCreatedProducerInput> = {},
): AdminAppointmentCreatedProducerInput {
  return {
    source: "ONLINE",
    appointment: {
      id: APPOINTMENT_ID,
      version: 3,
      serviceId: SERVICE_ID,
      masterId: MASTER_ID,
      startsAt: new Date("2026-10-05T07:00:00.000Z"),
      endsAt: new Date("2026-10-05T07:35:00.000Z"),
      durationMinutes: 35,
      businessTimeZone: "Europe/Moscow",
      serviceName: "Стрижка",
      masterName: "Анна",
    },
    ...overrides,
  };
}

function transaction(recipients = [FIRST_CONNECTION_ID, SECOND_CONNECTION_ID]) {
  const findMany = vi.fn(async () => recipients.map((id) => ({ id })));
  const queryRaw = vi.fn(async () => [{ now: OCCURRED_AT }]);
  const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  const nestedTransaction = vi.fn();
  return {
    tx: {
      adminTelegramConnection: { findMany },
      notificationOutbox: { createMany },
      $queryRaw: queryRaw,
      $transaction: nestedTransaction,
    } as unknown as Prisma.TransactionClient,
    findMany,
    queryRaw,
    createMany,
    nestedTransaction,
  };
}

function cancellationTransaction(
  input: {
    admins?: string[];
    client?: string | null;
    invalidatedRows?: Array<{ status: "CANCELLED" | "PROCESSING" }>;
  } = {},
) {
  const findMany = vi.fn(async () =>
    (input.admins ?? [FIRST_CONNECTION_ID, SECOND_CONNECTION_ID]).map((id) => ({ id })),
  );
  const findFirst = vi.fn(async () =>
    input.client === null ? null : { id: input.client ?? CLIENT_CONNECTION_ID },
  );
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce(
      (input.admins ?? [FIRST_CONNECTION_ID, SECOND_CONNECTION_ID]).map((id) => ({ id })),
    )
    .mockResolvedValueOnce([{ now: OCCURRED_AT }])
    .mockResolvedValueOnce(input.invalidatedRows ?? [{ status: "CANCELLED" }]);
  const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  const nestedTransaction = vi.fn();
  return {
    tx: {
      adminTelegramConnection: { findMany },
      appointmentTelegramConnection: { findFirst },
      notificationOutbox: { createMany },
      $queryRaw: queryRaw,
      $transaction: nestedTransaction,
    } as unknown as Prisma.TransactionClient,
    findMany,
    findFirst,
    queryRaw,
    createMany,
    nestedTransaction,
  };
}

describe("Telegram business producer", () => {
  it.each([
    ["ONLINE", "PUBLIC"],
    ["ADMIN", "ADMIN"],
  ] as const)("maps Appointment source %s to payload source %s", (source, expected) => {
    expect(adminAppointmentCreatedSource(source)).toBe(expected);
  });

  it("builds the exact VisitSnapshotV1 without PII or unknown fields", () => {
    const snapshot = buildVisitSnapshotV1({
      ...input().appointment,
      clientName: "PII_CANARY",
      clientPhone: "+79990000000",
      priceKopecks: 123_400,
      unknown: "UNKNOWN_CANARY",
    } as never);
    expect(snapshot).toEqual({
      serviceId: SERVICE_ID,
      masterId: MASTER_ID,
      startsAt: "2026-10-05T07:00:00.000Z",
      endsAt: "2026-10-05T07:35:00.000Z",
      durationMinutes: 35,
      businessTimeZone: "Europe/Moscow",
      serviceName: "Стрижка",
      masterName: "Анна",
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/PII_CANARY|79990000000|123400|UNKNOWN_CANARY/);
  });

  it("uses one database occurredAt and one exact dedupe key per immutable connection", async () => {
    const { tx, findMany, queryRaw, createMany, nestedTransaction } = transaction();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(produceAdminAppointmentCreated(tx, input())).resolves.toEqual({ created: 2 });

    expect(findMany).toHaveBeenCalledWith({
      where: { disabledAt: null, adminUser: { isActive: true } },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(nestedTransaction).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const data = createMany.mock.calls[0]?.[0].data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);
    expect(new Set(data.map((job) => job.scheduledAt))).toEqual(new Set([OCCURRED_AT]));
    expect(new Set(data.map((job) => job.nextAttemptAt))).toEqual(new Set([OCCURRED_AT]));
    expect(data.map((job) => job.dedupeKey)).toEqual(
      [FIRST_CONNECTION_ID, SECOND_CONNECTION_ID].map((adminConnectionId) =>
        buildAdminAppointmentCreatedDedupeKey({
          appointmentId: APPOINTMENT_ID,
          version: 3,
          adminConnectionId,
        }),
      ),
    );
    expect(new Set(data.map((job) => job.dedupeKey)).size).toBe(2);

    for (const job of data) {
      expect(job).toMatchObject({
        recipientKind: "ADMIN_CONNECTION",
        appointmentId: APPOINTMENT_ID,
        appointmentConnectionId: null,
        directChatId: null,
        type: "ADMIN_APPOINTMENT_CREATED",
        status: "PENDING",
        expiresAt: null,
        payloadVersion: 1,
        invalidatedAt: null,
        invalidationCode: null,
      });
      expect(
        parseTelegramPayloadV1({
          notificationType: "ADMIN_APPOINTMENT_CREATED",
          payloadVersion: job.payloadVersion,
          payload: job.payload,
        }),
      ).toMatchObject({
        ok: true,
        payload: {
          source: "PUBLIC",
          appointmentVersion: 3,
          occurredAt: OCCURRED_AT.toISOString(),
        },
      });
      expect(JSON.stringify(job.payload)).not.toMatch(/clientName|clientPhone|price|token|chat/i);
    }
  });

  it("creates no job and does not read the clock when there are no recipients", async () => {
    const { tx, queryRaw, createMany } = transaction([]);
    await expect(produceAdminAppointmentCreated(tx, input())).resolves.toEqual({ created: 0 });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("rejects malformed or extended input safely before database access", async () => {
    const { tx, findMany } = transaction();
    const canary = "RAW_CREDENTIAL_CANARY";
    const error = await produceAdminAppointmentCreated(tx, {
      ...input(),
      credential: canary,
    } as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramBusinessProducerError);
    expect(error).toMatchObject({ code: "BUSINESS_PRODUCER_INPUT_INVALID" });
    expect(JSON.stringify(error)).toBe(
      '{"name":"TelegramBusinessProducerError","code":"BUSINESS_PRODUCER_INPUT_INVALID"}',
    );
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(error).not.toHaveProperty("cause");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does not swallow a database insert failure", async () => {
    const { tx, createMany } = transaction();
    const failure = new Error("DATABASE_FAILURE_CANARY");
    createMany.mockRejectedValueOnce(failure);
    await expect(produceAdminAppointmentCreated(tx, input())).rejects.toBe(failure);
  });

  it("invalidates reminders and creates only admin jobs for a client cancellation", async () => {
    const { tx, findMany, findFirst, queryRaw, createMany, nestedTransaction } =
      cancellationTransaction({
        invalidatedRows: [{ status: "CANCELLED" }, { status: "PROCESSING" }],
      });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      produceAppointmentCancelled(tx, { actor: "CLIENT", appointment: input().appointment }),
    ).resolves.toEqual({
      adminCreated: 2,
      clientCreated: 0,
      reminderCancelled: 1,
      reminderInvalidated: 1,
    });

    expect(findMany).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(nestedTransaction).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const data = createMany.mock.calls[0]?.[0].data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);
    expect(data.map((job) => job.type)).toEqual([
      "ADMIN_APPOINTMENT_CANCELLED",
      "ADMIN_APPOINTMENT_CANCELLED",
    ]);
    expect(data.map((job) => job.dedupeKey)).toEqual(
      [FIRST_CONNECTION_ID, SECOND_CONNECTION_ID].map((adminConnectionId) =>
        buildAdminAppointmentCancelledDedupeKey({
          appointmentId: APPOINTMENT_ID,
          version: 3,
          adminConnectionId,
        }),
      ),
    );
    for (const job of data) {
      expect(job).toMatchObject({
        recipientKind: "ADMIN_CONNECTION",
        appointmentId: APPOINTMENT_ID,
        appointmentConnectionId: null,
        directChatId: null,
        scheduledAt: OCCURRED_AT,
        nextAttemptAt: OCCURRED_AT,
        expiresAt: null,
      });
      expect(
        parseTelegramPayloadV1({
          notificationType: "ADMIN_APPOINTMENT_CANCELLED",
          payloadVersion: job.payloadVersion,
          payload: job.payload,
        }),
      ).toMatchObject({
        ok: true,
        payload: {
          actor: "CLIENT",
          appointmentVersion: 3,
          occurredAt: OCCURRED_AT.toISOString(),
          visit: {
            serviceId: SERVICE_ID,
            masterId: MASTER_ID,
            durationMinutes: 35,
            businessTimeZone: "Europe/Moscow",
          },
        },
      });
      expect(JSON.stringify(job.payload)).not.toMatch(
        /clientName|clientPhone|reason|token|chat|price/i,
      );
    }
  });

  it("targets the active client connection and all active admins for an admin cancellation", async () => {
    const { tx, findFirst, createMany } = cancellationTransaction();

    await expect(
      produceAppointmentCancelled(tx, { actor: "ADMIN", appointment: input().appointment }),
    ).resolves.toMatchObject({ adminCreated: 2, clientCreated: 1 });

    expect(findFirst).toHaveBeenCalledWith({
      where: { appointmentId: APPOINTMENT_ID, disabledAt: null },
      select: { id: true },
    });
    const data = createMany.mock.calls[0]?.[0].data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(3);
    const clientJob = data.at(-1)!;
    expect(clientJob).toMatchObject({
      recipientKind: "APPOINTMENT_CONNECTION",
      appointmentId: APPOINTMENT_ID,
      appointmentConnectionId: CLIENT_CONNECTION_ID,
      adminConnectionId: null,
      type: "CLIENT_APPOINTMENT_CANCELLED",
      scheduledAt: OCCURRED_AT,
      nextAttemptAt: OCCURRED_AT,
    });
    expect(clientJob.dedupeKey).toBe(
      buildClientAppointmentCancelledDedupeKey({
        appointmentId: APPOINTMENT_ID,
        version: 3,
        appointmentConnectionId: CLIENT_CONNECTION_ID,
      }),
    );
    expect(
      parseTelegramPayloadV1({
        notificationType: "CLIENT_APPOINTMENT_CANCELLED",
        payloadVersion: clientJob.payloadVersion,
        payload: clientJob.payload,
      }),
    ).toMatchObject({
      ok: true,
      payload: { actor: "ADMIN", occurredAt: OCCURRED_AT.toISOString() },
    });
    expect(new Set(data.map((job) => job.scheduledAt))).toEqual(new Set([OCCURRED_AT]));
    expect(new Set(data.map((job) => job.dedupeKey)).size).toBe(3);
  });

  it("does not target a disabled client connection", async () => {
    const { tx, createMany } = cancellationTransaction({ client: null });
    await expect(
      produceAppointmentCancelled(tx, { actor: "ADMIN", appointment: input().appointment }),
    ).resolves.toMatchObject({ adminCreated: 2, clientCreated: 0 });
    expect(createMany.mock.calls[0]?.[0].data).toHaveLength(2);
  });

  it.each(["APPOINTMENT_COMPLETED", "APPOINTMENT_NO_SHOW"] as const)(
    "invalidates terminal reminders for %s without creating jobs",
    async (code) => {
      const { tx, queryRaw, createMany } = cancellationTransaction();
      queryRaw.mockReset();
      queryRaw
        .mockResolvedValueOnce([{ now: OCCURRED_AT }])
        .mockResolvedValueOnce([{ status: "CANCELLED" }]);
      await expect(
        invalidateAppointmentReminderForTerminalStatus(tx, {
          appointmentId: APPOINTMENT_ID,
          code,
        }),
      ).resolves.toEqual({ cancelled: 1, invalidated: 0 });
      expect(queryRaw).toHaveBeenCalledTimes(2);
      expect(createMany).not.toHaveBeenCalled();
    },
  );

  it("propagates cancellation fan-out storage failures", async () => {
    const { tx, createMany } = cancellationTransaction();
    const failure = new Error("DATABASE_FAILURE_CANARY");
    createMany.mockRejectedValueOnce(failure);
    await expect(
      produceAppointmentCancelled(tx, { actor: "ADMIN", appointment: input().appointment }),
    ).rejects.toBe(failure);
  });
});
