import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TelegramConnectionDisabledReason } from "../../src/generated/prisma/client";
import {
  TelegramOutboxRepository,
  invalidateTelegramOutbox,
} from "../../src/modules/telegram/server/outbox-repository";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import {
  OUTBOX_NOW,
  after,
  beforeCommitClient,
  createOutboxFixture,
  isolatedOutboxDatabaseUrl,
  owner,
} from "./telegram-outbox-fixture";

const database = createPrismaClient(isolatedOutboxDatabaseUrl());
let fixture: Awaited<ReturnType<typeof createOutboxFixture>>;
let now = OUTBOX_NOW;
let repository: TelegramOutboxRepository;
let extraAdminConnectionIds: string[] = [];

const noLease = { leaseToken: null, leaseOwner: null, claimedAt: null, leaseExpiresAt: null };
const read = (id: string) => database.notificationOutbox.findUniqueOrThrow({ where: { id } });

async function claimOne() {
  const jobs = await repository.claimDue({ capacity: 1, leaseOwner: owner() });
  expect(jobs).toHaveLength(1);
  return jobs[0];
}

async function finishPermanent(
  job: Awaited<ReturnType<typeof claimOne>>,
  errorCode:
    "CHAT_NOT_FOUND" | "BOT_BLOCKED" | "CHAT_WRITE_FORBIDDEN" | "TELEGRAM_USER_DEACTIVATED",
) {
  return repository.finish({ id: job.id, leaseToken: job.leaseToken, outcome: "DEAD", errorCode });
}

beforeEach(async () => {
  now = OUTBOX_NOW;
  extraAdminConnectionIds = [];
  fixture = await createOutboxFixture(database);
  repository = new TelegramOutboxRepository(database, { clock: () => now, random: () => 0 });
});

afterEach(async () => {
  await fixture.cleanupJobs();
  await database.adminTelegramConnection.deleteMany({
    where: { id: { in: extraAdminConnectionIds } },
  });
  await fixture.cleanup();
});

describe("Telegram permanent recipient failure", () => {
  it("atomically disables the immutable appointment connection for CHAT_NOT_FOUND", async () => {
    const row = await fixture.seed({
      type: "CLIENT_CONNECTION_CONFIRMED",
      scheduledAt: after(-1),
    });
    const job = await claimOne();

    await expect(finishPermanent(job, "CHAT_NOT_FOUND")).resolves.toEqual({
      kind: "APPLIED",
      status: "DEAD",
    });
    await expect(read(row.id)).resolves.toMatchObject({
      status: "DEAD",
      lastErrorCode: "CHAT_NOT_FOUND",
      finishedAt: now,
      ...noLease,
    });
    await expect(
      database.appointmentTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.clientConnectionId },
      }),
    ).resolves.toMatchObject({ disabledAt: now, disabledReason: "CHAT_NOT_FOUND" });
  });

  it("disables only the exact admin connection for BOT_BLOCKED", async () => {
    const active = await database.adminTelegramConnection.findUniqueOrThrow({
      where: { id: fixture.adminConnectionId },
    });
    const historical = await database.adminTelegramConnection.create({
      data: {
        adminUserId: active.adminUserId,
        telegramUserId: fixture.externalId + 20n,
        telegramChatId: fixture.externalId + 20n,
        sourceUpdateId: fixture.externalId + 20n,
        connectedAt: after(-1000),
        disabledAt: after(-500),
        disabledReason: "USER_DISCONNECTED",
      },
    });
    extraAdminConnectionIds.push(historical.id);
    const foreign = await fixture.seed({ adminConnectionId: historical.id });
    await fixture.seed({ scheduledAt: after(-1) });
    const job = await claimOne();

    await expect(finishPermanent(job, "BOT_BLOCKED")).resolves.toMatchObject({ status: "DEAD" });
    await expect(
      database.adminTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.adminConnectionId },
      }),
    ).resolves.toMatchObject({ disabledAt: now, disabledReason: "BOT_BLOCKED" });
    await expect(
      database.adminTelegramConnection.findUniqueOrThrow({ where: { id: historical.id } }),
    ).resolves.toEqual(historical);
    await expect(read(foreign.id)).resolves.toEqual(foreign);
  });

  it.each([
    ["CHAT_WRITE_FORBIDDEN", "ADMIN_CONNECTION"],
    ["TELEGRAM_USER_DEACTIVATED", "APPOINTMENT_CONNECTION"],
  ] as const)("persists %s as the disable reason for %s", async (errorCode, recipientKind) => {
    await fixture.seed({
      ...(recipientKind === "APPOINTMENT_CONNECTION"
        ? { type: "CLIENT_CONNECTION_CONFIRMED" as const }
        : {}),
      scheduledAt: after(-1),
    });
    const job = await claimOne();
    await finishPermanent(job, errorCode);
    const connection =
      recipientKind === "APPOINTMENT_CONNECTION"
        ? await database.appointmentTelegramConnection.findUniqueOrThrow({
            where: { id: fixture.clientConnectionId },
          })
        : await database.adminTelegramConnection.findUniqueOrThrow({
            where: { id: fixture.adminConnectionId },
          });
    expect(connection).toMatchObject({ disabledAt: now, disabledReason: errorCode });
  });

  it("cancels PENDING siblings and invalidates PROCESSING siblings without changing their lease", async () => {
    const processingToken = randomUUID();
    const processingOwner = owner();
    const processing = await fixture.seed({
      status: "PROCESSING",
      attempts: 1,
      leaseToken: processingToken,
      leaseOwner: processingOwner,
      claimedAt: now,
      leaseExpiresAt: after(60_000),
    });
    const pending = await fixture.seed({ scheduledAt: after(1000) });
    await fixture.seed({ scheduledAt: after(-1) });
    const current = await claimOne();

    await finishPermanent(current, "BOT_BLOCKED");
    await expect(read(pending.id)).resolves.toMatchObject({
      status: "CANCELLED",
      invalidationCode: "CONNECTION_DISABLED",
      invalidatedAt: now,
      finishedAt: now,
      ...noLease,
    });
    await expect(read(processing.id)).resolves.toMatchObject({
      status: "PROCESSING",
      invalidationCode: "CONNECTION_DISABLED",
      invalidatedAt: now,
      leaseToken: processingToken,
      leaseOwner: processingOwner,
      claimedAt: now,
      leaseExpiresAt: after(60_000),
      finishedAt: null,
    });
    await expect(
      repository.finish({
        id: processing.id,
        leaseToken: processingToken,
        outcome: "DEAD",
        errorCode: "CHAT_NOT_FOUND",
      }),
    ).resolves.toEqual({ kind: "APPLIED", status: "SKIPPED" });
    await expect(read(processing.id)).resolves.toMatchObject({
      status: "SKIPPED",
      lastErrorCode: "CONNECTION_INACTIVE",
      ...noLease,
    });
  });

  it("keeps DIRECT_CHAT isolated from every saved connection and queue", async () => {
    const sibling = await fixture.seed({ scheduledAt: after(1000) });
    const direct = await fixture.seed({
      type: "TELEGRAM_CONNECTION_REJECTED",
      scheduledAt: after(-1),
    });
    const job = await claimOne();
    await finishPermanent(job, "CHAT_NOT_FOUND");

    await expect(read(direct.id)).resolves.toMatchObject({
      status: "DEAD",
      lastErrorCode: "CHAT_NOT_FOUND",
    });
    await expect(read(sibling.id)).resolves.toEqual(sibling);
    expect(
      await database.appointmentTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.clientConnectionId },
      }),
    ).toMatchObject({ disabledAt: null, disabledReason: null });
    expect(
      await database.adminTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.adminConnectionId },
      }),
    ).toMatchObject({ disabledAt: null, disabledReason: null });
  });

  it("does not disable for INVALID_REQUEST, RETRY, CONFIGURATION_FAILURE or SENT", async () => {
    const commands = [
      { outcome: "DEAD", errorCode: "INVALID_REQUEST" },
      { outcome: "RETRY", errorCode: "TELEGRAM_5XX" },
      { outcome: "CONFIGURATION_FAILURE", errorCode: "CONFIG_UNAUTHORIZED" },
      { outcome: "SENT" },
    ] as const;
    for (const command of commands) {
      await fixture.seed({ scheduledAt: after(-1) });
      const job = await claimOne();
      await repository.finish({ id: job.id, leaseToken: job.leaseToken, ...command });
    }
    await expect(
      database.adminTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.adminConnectionId },
      }),
    ).resolves.toMatchObject({ disabledAt: null, disabledReason: null });
  });

  it("lost and expired leases plus terminal jobs have no disable side effects", async () => {
    const sibling = await fixture.seed({ scheduledAt: after(1000) });
    await fixture.seed({ scheduledAt: after(-1) });
    const job = await claimOne();
    const before = await read(job.id);
    await expect(
      repository.finish({
        id: job.id,
        leaseToken: randomUUID(),
        outcome: "DEAD",
        errorCode: "BOT_BLOCKED",
      }),
    ).resolves.toEqual({ kind: "LEASE_LOST" });
    expect(await read(job.id)).toEqual(before);

    now = after(60_000);
    await expect(finishPermanent(job, "BOT_BLOCKED")).resolves.toEqual({ kind: "LEASE_LOST" });
    await expect(read(sibling.id)).resolves.toEqual(sibling);
    await expect(
      database.adminTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.adminConnectionId },
      }),
    ).resolves.toMatchObject({ disabledAt: null });

    const terminal = await fixture.seed({ status: "DEAD", finishedAt: now });
    await expect(
      repository.finish({
        id: terminal.id,
        leaseToken: randomUUID(),
        outcome: "DEAD",
        errorCode: "BOT_BLOCKED",
      }),
    ).resolves.toEqual({ kind: "TERMINAL", status: "DEAD" });
    await expect(read(terminal.id)).resolves.toEqual(terminal);
  });

  it("honors prior invalidation and never overwrites an existing disable reason", async () => {
    await fixture.seed({ scheduledAt: after(-1) });
    const job = await claimOne();
    const firstDisabledAt = after(-1000);
    await database.adminTelegramConnection.update({
      where: { id: fixture.adminConnectionId },
      data: { disabledAt: firstDisabledAt, disabledReason: "USER_DISCONNECTED" },
    });
    await invalidateTelegramOutbox(database, {
      target: { kind: "ADMIN_CONNECTION", id: fixture.adminConnectionId },
      code: "CONNECTION_DISABLED",
      now,
    });

    await expect(finishPermanent(job, "BOT_BLOCKED")).resolves.toEqual({
      kind: "APPLIED",
      status: "SKIPPED",
    });
    await expect(
      database.adminTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.adminConnectionId },
      }),
    ).resolves.toMatchObject({
      disabledAt: firstDisabledAt,
      disabledReason: "USER_DISCONNECTED",
    });
  });

  it("keeps the first disable reason when an already disabled connection has no job invalidation", async () => {
    await fixture.seed({ scheduledAt: after(-1) });
    const job = await claimOne();
    const firstDisabledAt = after(-1000);
    const firstReason: TelegramConnectionDisabledReason = "CHAT_NOT_FOUND";
    await database.adminTelegramConnection.update({
      where: { id: fixture.adminConnectionId },
      data: { disabledAt: firstDisabledAt, disabledReason: firstReason },
    });

    await expect(finishPermanent(job, "BOT_BLOCKED")).resolves.toEqual({
      kind: "APPLIED",
      status: "SKIPPED",
    });
    await expect(read(job.id)).resolves.toMatchObject({
      status: "SKIPPED",
      invalidationCode: "CONNECTION_DISABLED",
      lastErrorCode: "CONNECTION_INACTIVE",
    });
    await expect(
      database.adminTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.adminConnectionId },
      }),
    ).resolves.toMatchObject({ disabledAt: firstDisabledAt, disabledReason: firstReason });
  });

  it("rolls back finalization, disable and sibling invalidation on one transaction failure", async () => {
    const sibling = await fixture.seed({ scheduledAt: after(1000) });
    await fixture.seed({ scheduledAt: after(-1) });
    const job = await claimOne();
    const currentBefore = await read(job.id);
    const connectionBefore = await database.adminTelegramConnection.findUniqueOrThrow({
      where: { id: fixture.adminConnectionId },
    });
    const faulting = beforeCommitClient(database, async (tx) => {
      expect(
        await tx.adminTelegramConnection.findUniqueOrThrow({
          where: { id: fixture.adminConnectionId },
        }),
      ).toMatchObject({ disabledAt: now, disabledReason: "BOT_BLOCKED" });
      expect(
        await tx.notificationOutbox.findUniqueOrThrow({ where: { id: sibling.id } }),
      ).toMatchObject({
        status: "CANCELLED",
        invalidationCode: "CONNECTION_DISABLED",
      });
      expect(
        await tx.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } }),
      ).toMatchObject({
        status: "DEAD",
        lastErrorCode: "BOT_BLOCKED",
      });
      throw new Error("test rollback");
    });
    const broken = new TelegramOutboxRepository(faulting, { clock: () => now });

    await expect(
      broken.finish({
        id: job.id,
        leaseToken: job.leaseToken,
        outcome: "DEAD",
        errorCode: "BOT_BLOCKED",
      }),
    ).rejects.toMatchObject({ code: "OUTBOX_STORAGE_FAILURE" });
    await expect(read(job.id)).resolves.toEqual(currentBefore);
    await expect(read(sibling.id)).resolves.toEqual(sibling);
    await expect(
      database.adminTelegramConnection.findUniqueOrThrow({
        where: { id: fixture.adminConnectionId },
      }),
    ).resolves.toEqual(connectionBefore);
  });
});
