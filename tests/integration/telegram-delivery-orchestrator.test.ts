import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { TelegramBotApi } from "../../src/modules/telegram/server/bot-api";
import { TelegramDeliveryAttempt } from "../../src/modules/telegram/server/delivery-attempt";
import { TelegramDeliveryOrchestrator } from "../../src/modules/telegram/server/delivery-orchestrator";
import { TelegramDeliveryPreflight } from "../../src/modules/telegram/server/delivery-preflight";
import type { TelegramDeliveryRateGate } from "../../src/modules/telegram/server/delivery-rate-gate";
import { TelegramOutboxDispatcher } from "../../src/modules/telegram/server/outbox-dispatcher";
import { TelegramOutboxRepository } from "../../src/modules/telegram/server/outbox-repository";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import {
  bounded,
  createOutboxFixture,
  isolatedOutboxDatabaseUrl,
  owner,
} from "./telegram-outbox-fixture";

const database = createPrismaClient(isolatedOutboxDatabaseUrl());
let fixture: Awaited<ReturnType<typeof createOutboxFixture>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  fixture = await createOutboxFixture(database);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanupJobs();
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

describe("Telegram delivery lifecycle with PostgreSQL", () => {
  it("recovers an expired lease, dispatches it through the real pipeline, and settles before stop", async () => {
    let monotonicNow = 0;
    const outbox = new TelegramOutboxRepository(database, {
      random: () => 0,
    });
    const now = Date.now();
    const recoveredJob = await fixture.seed({
      status: "PROCESSING",
      attempts: 6,
      leaseToken: randomUUID(),
      leaseOwner: owner(),
      claimedAt: new Date(now - 120_000),
      leaseExpiresAt: new Date(now - 60_000),
    });
    const dueAt = new Date(now - 5_000);
    const dueJob = await fixture.seed({ scheduledAt: dueAt, nextAttemptAt: dueAt });
    const sendStarted = deferred<AbortSignal>();
    const sendRelease = deferred<{ messageId: bigint }>();
    const sendMessage = vi.fn<Pick<TelegramBotApi, "sendMessage">["sendMessage"]>(
      async (_input, options) => {
        if (!options?.signal) throw new Error("Expected lifecycle signal");
        sendStarted.resolve(options.signal);
        return sendRelease.promise;
      },
    );
    const rateGate = {
      run: async (
        input: { chatId: bigint; signal?: AbortSignal },
        operation: (signal: AbortSignal) => Promise<unknown>,
      ) => operation(input.signal ?? new AbortController().signal),
    } as Pick<TelegramDeliveryRateGate, "run">;
    const attempt = new TelegramDeliveryAttempt({
      preflight: new TelegramDeliveryPreflight(database),
      rateGate,
      api: { sendMessage },
      outbox,
    });
    const dispatcher = new TelegramOutboxDispatcher({ outbox, attempt }, { concurrency: 1 });

    let activeOperations = 0;
    let maximumOperations = 0;
    const originalRecover = outbox.recoverExpired.bind(outbox);
    const recoverExpired = vi.spyOn(outbox, "recoverExpired").mockImplementation(async (input) => {
      activeOperations += 1;
      maximumOperations = Math.max(maximumOperations, activeOperations);
      try {
        return await originalRecover(input);
      } finally {
        activeOperations -= 1;
      }
    });
    const originalDispatch = dispatcher.dispatchOnce.bind(dispatcher);
    const dispatchOnce = vi.spyOn(dispatcher, "dispatchOnce").mockImplementation(async (input) => {
      activeOperations += 1;
      maximumOperations = Math.max(maximumOperations, activeOperations);
      try {
        return await originalDispatch(input);
      } finally {
        activeOperations -= 1;
      }
    });
    let sleeps = 0;
    const orchestrator = new TelegramDeliveryOrchestrator(
      {
        dispatcher,
        outbox,
        logger: { log: vi.fn() },
        monotonicNow: () => monotonicNow,
        sleep: async (milliseconds) => {
          sleeps += 1;
          monotonicNow += milliseconds;
          void orchestrator.stop();
        },
      },
      {
        dispatchIntervalMs: 1,
        recoveryIntervalMs: 60_000,
        recoveryBatchSize: 1,
        errorBackoffMs: 1,
      },
    );

    const running = orchestrator.run();
    const signal = await Promise.race([sendStarted.promise, running.then(() => undefined)]);
    if (!signal) {
      const stored = await database.notificationOutbox.findUniqueOrThrow({
        where: { id: dueJob.id },
      });
      throw new Error(
        `Delivery did not start: ${stored.status}/${stored.lastErrorCode}/${stored.attempts}`,
      );
    }
    expect(recoverExpired).toHaveBeenCalledOnce();
    expect(dispatchOnce).toHaveBeenCalledOnce();
    expect(sleeps).toBe(0);
    expect(maximumOperations).toBe(1);
    expect(sendMessage).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = orchestrator.stop().then(() => {
      stopped = true;
    });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(dispatchOnce).toHaveBeenCalledOnce();
    expect(recoverExpired).toHaveBeenCalledOnce();

    sendRelease.resolve({ messageId: 1n });
    await bounded(Promise.all([running, stopping]), 5_000);

    await expect(
      database.notificationOutbox.findUniqueOrThrow({ where: { id: dueJob.id } }),
    ).resolves.toMatchObject({
      status: "SENT",
      attempts: 1,
      leaseToken: null,
      leaseOwner: null,
      lastErrorCode: null,
    });
    await expect(
      database.notificationOutbox.findUniqueOrThrow({ where: { id: recoveredJob.id } }),
    ).resolves.toMatchObject({
      status: "DEAD",
      attempts: 6,
      leaseToken: null,
      leaseOwner: null,
      lastErrorCode: "DELIVERY_OUTCOME_UNKNOWN",
    });
    await expect(
      database.notificationOutbox.count({ where: { status: "PROCESSING" } }),
    ).resolves.toBe(0);
  });
});
