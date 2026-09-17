import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  TelegramBotApiError,
  type TelegramBotApi,
} from "../../src/modules/telegram/server/bot-api";
import { TelegramDeliveryAttempt } from "../../src/modules/telegram/server/delivery-attempt";
import { TelegramDeliveryPreflight } from "../../src/modules/telegram/server/delivery-preflight";
import type { TelegramDeliveryRateGate } from "../../src/modules/telegram/server/delivery-rate-gate";
import { TelegramOutboxDispatcher } from "../../src/modules/telegram/server/outbox-dispatcher";
import { TelegramOutboxRepository } from "../../src/modules/telegram/server/outbox-repository";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { createOutboxFixture, isolatedOutboxDatabaseUrl } from "./telegram-outbox-fixture";

const database = createPrismaClient(isolatedOutboxDatabaseUrl());
const outbox = new TelegramOutboxRepository(database, { random: () => 0 });
const preflight = new TelegramDeliveryPreflight(database);
let fixture: Awaited<ReturnType<typeof createOutboxFixture>>;

function dueAt() {
  return new Date(Date.now() - 1_000);
}

function fakeGate() {
  const signal = new AbortController().signal;
  const run = vi.fn(
    async (
      _input: { chatId: bigint; signal?: AbortSignal },
      operation: (signal: AbortSignal) => Promise<unknown>,
    ) => operation(signal),
  );
  return {
    run,
    dependency: {
      run: run as unknown as Pick<TelegramDeliveryRateGate, "run">["run"],
    },
  };
}

function composition(
  sendMessage: Pick<TelegramBotApi, "sendMessage">["sendMessage"],
  capacity = 2,
) {
  const gate = fakeGate();
  const attempt = new TelegramDeliveryAttempt({
    preflight,
    rateGate: gate.dependency,
    api: { sendMessage },
    outbox,
  });
  return {
    gate,
    dispatcher: new TelegramOutboxDispatcher({ outbox, attempt }, { concurrency: capacity }),
  };
}

async function storedJobs() {
  return database.notificationOutbox.findMany({
    orderBy: { id: "asc" },
  });
}

beforeAll(async () => {
  fixture = await createOutboxFixture(database);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanupJobs();
  await database.adminTelegramConnection.update({
    where: { id: fixture.adminConnectionId },
    data: { disabledAt: null, disabledReason: null },
  });
  await database.appointmentTelegramConnection.update({
    where: { id: fixture.clientConnectionId },
    data: { disabledAt: null, disabledReason: null },
  });
});

afterAll(async () => {
  const advisoryLocks = await database.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  `;
  expect(advisoryLocks[0]?.count).toBe(0n);
  await fixture?.cleanup();
  await database.$disconnect();
});

describe("Telegram outbox dispatcher with PostgreSQL", () => {
  it("claims due jobs and completes claim -> preflight -> gate -> send -> SENT", async () => {
    const scheduledAt = dueAt();
    const job = await fixture.seed({ scheduledAt, nextAttemptAt: scheduledAt });
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 1n });
    const { dispatcher, gate } = composition(sendMessage, 1);

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      claimed: 1,
      started: 1,
      completed: 1,
      outcomes: { sent: 1 },
    });

    expect(gate.run).toHaveBeenCalledOnce();
    expect(gate.run.mock.calls[0]?.[0]).toEqual({ chatId: fixture.externalId + 1n });
    expect(sendMessage).toHaveBeenCalledOnce();
    await expect(
      database.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({ status: "SENT", leaseToken: null, lastErrorCode: null });
  });

  it("does not enter the gate for SKIP or DEAD preflight", async () => {
    const scheduledAt = dueAt();
    await fixture.seed({ scheduledAt, nextAttemptAt: scheduledAt });
    await database.adminTelegramConnection.update({
      where: { id: fixture.adminConnectionId },
      data: { disabledAt: new Date(), disabledReason: "USER_DISCONNECTED" },
    });
    await fixture.seed({
      type: "TELEGRAM_CONNECTION_REJECTED",
      scheduledAt,
      nextAttemptAt: scheduledAt,
      payloadVersion: 2,
    });
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 1n });
    const { dispatcher, gate } = composition(sendMessage);

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      claimed: 2,
      completed: 2,
      outcomes: { dead: 1, skipped: 1 },
    });

    expect(gate.run).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns a retryable send error to PENDING", async () => {
    const scheduledAt = dueAt();
    await fixture.seed({ scheduledAt, nextAttemptAt: scheduledAt });
    const sendMessage = vi
      .fn()
      .mockRejectedValue(
        new TelegramBotApiError({ operation: "sendMessage", code: "TELEGRAM_5XX" }),
      );
    const { dispatcher, gate } = composition(sendMessage, 1);

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      outcomes: { pending: 1 },
      errors: { attemptFailed: 0 },
    });

    expect(gate.run).toHaveBeenCalledOnce();
    await expect(storedJobs()).resolves.toEqual([
      expect.objectContaining({
        status: "PENDING",
        attempts: 1,
        lastErrorCode: "TELEGRAM_5XX",
        leaseToken: null,
      }),
    ]);
  });

  it("preserves permanent-error connection disabling semantics", async () => {
    const scheduledAt = dueAt();
    await fixture.seed({ scheduledAt, nextAttemptAt: scheduledAt });
    const sendMessage = vi
      .fn()
      .mockRejectedValue(
        new TelegramBotApiError({ operation: "sendMessage", code: "BOT_BLOCKED" }),
      );
    const { dispatcher } = composition(sendMessage, 1);

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      outcomes: { dead: 1 },
    });

    await expect(
      database.adminTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.adminConnectionId },
      }),
    ).resolves.toMatchObject({
      disabledReason: "BOT_BLOCKED",
      disabledAt: expect.any(Date),
    });
  });

  it("claims only immediate capacity and runs no more attempts concurrently", async () => {
    const scheduledAt = dueAt();
    await Promise.all([
      fixture.seed({ scheduledAt, nextAttemptAt: scheduledAt }),
      fixture.seed({ scheduledAt, nextAttemptAt: scheduledAt }),
      fixture.seed({ scheduledAt, nextAttemptAt: scheduledAt }),
    ]);
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const sendMessage = vi.fn(
      () =>
        new Promise<{ messageId: bigint }>((resolve) => {
          active += 1;
          maximum = Math.max(maximum, active);
          releases.push(() => {
            active -= 1;
            resolve({ messageId: 1n });
          });
        }),
    );
    const { dispatcher } = composition(sendMessage, 2);

    const pending = dispatcher.dispatchOnce();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(maximum).toBe(2);
    releases.forEach((release) => release());
    await expect(pending).resolves.toMatchObject({ claimed: 2, started: 2, completed: 2 });

    const jobs = await storedJobs();
    expect(jobs.filter((job) => job.status === "SENT")).toHaveLength(2);
    expect(jobs.filter((job) => job.status === "PENDING")).toHaveLength(1);
  });

  it("settles a failing delivery outcome without abandoning its claimed neighbor", async () => {
    const scheduledAt = dueAt();
    await Promise.all([
      fixture.seed({ scheduledAt, nextAttemptAt: scheduledAt }),
      fixture.seed({ scheduledAt, nextAttemptAt: scheduledAt }),
    ]);
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(
        new TelegramBotApiError({ operation: "sendMessage", code: "TELEGRAM_5XX" }),
      )
      .mockResolvedValueOnce({ messageId: 2n });
    const { dispatcher } = composition(sendMessage);

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      claimed: 2,
      started: 2,
      completed: 2,
      outcomes: { pending: 1, sent: 1 },
      errors: { attemptFailed: 0 },
    });

    const jobs = await storedJobs();
    expect(jobs.filter((job) => job.status === "SENT")).toHaveLength(1);
    expect(jobs.filter((job) => job.status === "PENDING")).toHaveLength(1);
    expect(jobs.some((job) => job.status === "PROCESSING")).toBe(false);
  });
});
