import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  TelegramBotApiError,
  type TelegramBotApi,
} from "../../src/modules/telegram/server/bot-api";
import { TelegramDeliveryAttempt } from "../../src/modules/telegram/server/delivery-attempt";
import { TelegramDeliveryPreflight } from "../../src/modules/telegram/server/delivery-preflight";
import {
  invalidateTelegramOutbox,
  TelegramOutboxRepository,
} from "../../src/modules/telegram/server/outbox-repository";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { createOutboxFixture, isolatedOutboxDatabaseUrl, owner } from "./telegram-outbox-fixture";

const database = createPrismaClient(isolatedOutboxDatabaseUrl());
const outbox = new TelegramOutboxRepository(database, { random: () => 0 });
const preflight = new TelegramDeliveryPreflight(database);
let fixture: Awaited<ReturnType<typeof createOutboxFixture>>;

async function claimedJob() {
  const dueAt = new Date(Date.now() - 5000);
  const job = await fixture.seed({ scheduledAt: dueAt, nextAttemptAt: dueAt });
  const [claimed] = await outbox.claimDue({ capacity: 1, leaseOwner: owner() });
  expect(claimed?.id).toBe(job.id);
  if (!claimed) throw new Error("Expected a claimed job");
  return claimed;
}

function attemptWith(sendMessage: Pick<TelegramBotApi, "sendMessage">["sendMessage"]) {
  return new TelegramDeliveryAttempt({
    preflight,
    rateGate: {
      run: async (_input, operation) => operation(new AbortController().signal),
    },
    api: { sendMessage },
    outbox,
  });
}

async function read(id: string) {
  return database.notificationOutbox.findUniqueOrThrow({ where: { id } });
}

async function invalidateClaimedJob() {
  return invalidateTelegramOutbox(database, {
    target: { kind: "ADMIN_CONNECTION", id: fixture.adminConnectionId },
    code: "BOT_REPLACED",
    now: new Date(),
  });
}

beforeAll(async () => {
  fixture = await createOutboxFixture(database);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanupJobs();
});
afterAll(async () => {
  await fixture?.cleanup();
  await database.$disconnect();
});

describe("Telegram delivery attempt with PostgreSQL", () => {
  it("sends once and persists SENT", async () => {
    const job = await claimedJob();
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 1n });

    await expect(
      attemptWith(sendMessage).run({ jobId: job.id, leaseToken: job.leaseToken }),
    ).resolves.toEqual({ kind: "FINISHED", finish: { kind: "APPLIED", status: "SENT" } });

    expect(sendMessage).toHaveBeenCalledOnce();
    await expect(read(job.id)).resolves.toMatchObject({
      status: "SENT",
      attempts: 1,
      lastErrorCode: null,
      leaseToken: null,
    });
  });

  it("returns a retryable error to PENDING with a calculated next attempt", async () => {
    const job = await claimedJob();
    const sendMessage = vi
      .fn()
      .mockRejectedValue(
        new TelegramBotApiError({ operation: "sendMessage", code: "TELEGRAM_5XX" }),
      );

    await expect(
      attemptWith(sendMessage).run({ jobId: job.id, leaseToken: job.leaseToken }),
    ).resolves.toEqual({ kind: "FINISHED", finish: { kind: "APPLIED", status: "PENDING" } });

    const stored = await read(job.id);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(stored).toMatchObject({
      status: "PENDING",
      attempts: 1,
      lastErrorCode: "TELEGRAM_5XX",
      leaseToken: null,
    });
    expect(stored.nextAttemptAt.getTime()).toBeGreaterThan(job.claimedAt.getTime());
  });

  it("compensates the attempt for CONFIG_UNAUTHORIZED", async () => {
    const job = await claimedJob();
    const sendMessage = vi.fn().mockRejectedValue(
      new TelegramBotApiError({
        operation: "sendMessage",
        code: "CONFIG_UNAUTHORIZED",
      }),
    );

    await expect(
      attemptWith(sendMessage).run({ jobId: job.id, leaseToken: job.leaseToken }),
    ).resolves.toEqual({ kind: "FINISHED", finish: { kind: "APPLIED", status: "PENDING" } });

    await expect(read(job.id)).resolves.toMatchObject({
      status: "PENDING",
      attempts: 0,
      lastErrorCode: "CONFIG_UNAUTHORIZED",
      leaseToken: null,
    });
  });

  it("keeps a successful HTTP delivery as SENT after concurrent invalidation", async () => {
    const job = await claimedJob();
    const sendMessage = vi.fn(async () => {
      expect(await invalidateClaimedJob()).toEqual({ cancelled: 0, invalidated: 1 });
      return { messageId: 1n };
    });

    await expect(
      attemptWith(sendMessage).run({ jobId: job.id, leaseToken: job.leaseToken }),
    ).resolves.toEqual({ kind: "FINISHED", finish: { kind: "APPLIED", status: "SENT" } });

    expect(sendMessage).toHaveBeenCalledOnce();
    await expect(read(job.id)).resolves.toMatchObject({
      status: "SENT",
      invalidationCode: "BOT_REPLACED",
      lastErrorCode: null,
    });
  });

  it("turns an HTTP error into SKIPPED after concurrent invalidation", async () => {
    const job = await claimedJob();
    const sendMessage = vi.fn(async () => {
      expect(await invalidateClaimedJob()).toEqual({ cancelled: 0, invalidated: 1 });
      throw new TelegramBotApiError({ operation: "sendMessage", code: "TELEGRAM_5XX" });
    });

    await expect(
      attemptWith(sendMessage).run({ jobId: job.id, leaseToken: job.leaseToken }),
    ).resolves.toEqual({ kind: "FINISHED", finish: { kind: "APPLIED", status: "SKIPPED" } });

    expect(sendMessage).toHaveBeenCalledOnce();
    await expect(read(job.id)).resolves.toMatchObject({
      status: "SKIPPED",
      invalidationCode: "BOT_REPLACED",
      lastErrorCode: "CONNECTION_INACTIVE",
    });
  });
});
