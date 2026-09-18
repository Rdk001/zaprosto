import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { TelegramBotApi } from "../../src/modules/telegram/server/bot-api";
import { TelegramBotStateRepository } from "../../src/modules/telegram/server/bot-state-repository";
import { TelegramDeliveryAttempt } from "../../src/modules/telegram/server/delivery-attempt";
import { TelegramDeliveryOrchestrator } from "../../src/modules/telegram/server/delivery-orchestrator";
import { TelegramDeliveryPreflight } from "../../src/modules/telegram/server/delivery-preflight";
import { TelegramDeliveryRateGate } from "../../src/modules/telegram/server/delivery-rate-gate";
import { verifyTelegramDeliveryReadiness } from "../../src/modules/telegram/server/delivery-readiness-service";
import { TelegramDeliverySupervisor } from "../../src/modules/telegram/server/delivery-supervisor";
import { TelegramOutboxDispatcher } from "../../src/modules/telegram/server/outbox-dispatcher";
import { TelegramOutboxRepository } from "../../src/modules/telegram/server/outbox-repository";
import type { TelegramRuntimeConfiguration } from "../../src/modules/telegram/server/runtime-config";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { bounded, createOutboxFixture, isolatedOutboxDatabaseUrl } from "./telegram-outbox-fixture";

const connectionString = isolatedOutboxDatabaseUrl();
const database = createPrismaClient(connectionString);
const pool = new pg.Pool({ connectionString, max: 2 });
const enabled = {
  kind: "ENABLED",
  botToken: "123456:WORKER_RUNTIME_FAKE_TOKEN_123456",
  botUsername: "Zaprosto_Test_Bot",
  pollTimeoutSeconds: 30,
} as const satisfies TelegramRuntimeConfiguration;
let fixture: Awaited<ReturnType<typeof createOutboxFixture>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function advisoryLockCount() {
  const rows = await database.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  `;
  return rows[0]?.count;
}

beforeAll(async () => {
  fixture = await createOutboxFixture(database);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanupJobs();
  await database.telegramBotState.update({
    where: { id: 1 },
    data: {
      botUserId: null,
      botUsername: null,
      lastVerifiedAt: null,
      lastPollAt: null,
      lastErrorCode: null,
      nextUpdateId: 0n,
    },
  });
  expect(await advisoryLockCount()).toBe(0n);
});

afterAll(async () => {
  await fixture?.cleanup();
  await pool.end();
  await database.$disconnect();
});

describe("Telegram worker delivery runtime with PostgreSQL", () => {
  it("dispatches VERIFIED identity without a polling leader and settles SENT on shutdown", async () => {
    const due = new Date(Date.now() - 1_000);
    const job = await fixture.seed({ scheduledAt: due, nextAttemptAt: due });
    const sent = deferred<void>();
    const api = {
      getMe: vi.fn(async () => ({ id: 42n, username: "zaprosto_test_bot" })),
      sendMessage: vi.fn(async () => {
        sent.resolve();
        return { messageId: 1n };
      }),
    } as unknown as TelegramBotApi;
    const state = new TelegramBotStateRepository(database);
    const outbox = new TelegramOutboxRepository(database, { random: () => 0 });
    const rateGate = new TelegramDeliveryRateGate(pool);
    const supervisor = new TelegramDeliverySupervisor({
      configuration: () => enabled,
      createApi: () => api,
      verifyReadiness: ({ configuration, api: currentApi, signal }) =>
        verifyTelegramDeliveryReadiness({
          configuration,
          api: currentApi,
          state,
          signal,
        }),
      createLifecycle: ({ api: deliveryApi }) => {
        const attempt = new TelegramDeliveryAttempt({
          preflight: new TelegramDeliveryPreflight(database),
          rateGate,
          api: deliveryApi,
          outbox,
        });
        const dispatcher = new TelegramOutboxDispatcher({ outbox, attempt }, { concurrency: 1 });
        return new TelegramDeliveryOrchestrator(
          { dispatcher, outbox, logger: { log: vi.fn() } },
          {
            dispatchIntervalMs: 5,
            recoveryIntervalMs: 60_000,
            recoveryBatchSize: 1,
            errorBackoffMs: 5,
          },
        );
      },
      logger: { log: vi.fn() },
      readinessRecheckMs: 60_000,
    });

    const running = supervisor.run();
    await bounded(sent.promise, 5_000);
    await bounded(supervisor.stop(), 5_000);
    await bounded(running, 5_000);

    expect(api.getMe).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenCalledOnce();
    await expect(
      database.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({ status: "SENT", leaseToken: null, lastErrorCode: null });
    await expect(
      database.notificationOutbox.count({ where: { status: "PROCESSING" } }),
    ).resolves.toBe(0);
    expect(await advisoryLockCount()).toBe(0n);
  });

  it("does not claim a due job when the stored bot identity differs", async () => {
    const due = new Date(Date.now() - 1_000);
    const job = await fixture.seed({ scheduledAt: due, nextAttemptAt: due });
    await database.telegramBotState.update({
      where: { id: 1 },
      data: { botUserId: 99n, botUsername: "zaprosto_test_bot" },
    });
    const api = {
      getMe: vi.fn(async () => ({ id: 42n, username: "zaprosto_test_bot" })),
    } as unknown as TelegramBotApi;
    const createLifecycle = vi.fn();
    const supervisor = new TelegramDeliverySupervisor({
      configuration: () => enabled,
      createApi: () => api,
      verifyReadiness: ({ configuration, api: currentApi, signal }) =>
        verifyTelegramDeliveryReadiness({
          configuration,
          api: currentApi,
          state: new TelegramBotStateRepository(database),
          signal,
        }),
      createLifecycle,
      logger: { log: vi.fn() },
      readinessRecheckMs: 5,
      sleep: vi.fn(async () => void supervisor.stop()),
    });

    await bounded(supervisor.run(), 5_000);

    expect(createLifecycle).not.toHaveBeenCalled();
    await expect(
      database.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({ status: "PENDING", attempts: 0, leaseToken: null });
  });
});
