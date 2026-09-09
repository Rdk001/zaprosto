import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import { decideTelegramRetry } from "../../src/modules/telegram/domain/retry";
import {
  TelegramOutboxRepository,
  invalidateTelegramOutbox,
} from "../../src/modules/telegram/server/outbox-repository";
import {
  OUTBOX_INVALIDATION_CODES,
  OUTBOX_SKIP_CODES,
  type ClaimedOutboxJob,
  type FinishOutboxInput,
} from "../../src/modules/telegram/server/outbox-contract";
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
const repository = new TelegramOutboxRepository(database, { clock: () => now, random: () => 0 });
const noLease = { leaseToken: null, leaseOwner: null, claimedAt: null, leaseExpiresAt: null };
const fetchSpy = vi.fn(() => {
  throw new Error("Network is forbidden in outbox tests");
});

async function claim() {
  const jobs = await repository.claimDue({ capacity: 1, leaseOwner: owner() });
  expect(jobs).toHaveLength(1);
  return jobs[0];
}
function sent(job: ClaimedOutboxJob): Extract<FinishOutboxInput, { outcome: "SENT" }> {
  return { id: job.id, leaseToken: job.leaseToken, outcome: "SENT" };
}
function retry(job: ClaimedOutboxJob): Extract<FinishOutboxInput, { outcome: "RETRY" }> {
  return { id: job.id, leaseToken: job.leaseToken, outcome: "RETRY", errorCode: "TELEGRAM_5XX" };
}
function configuration(
  job: ClaimedOutboxJob,
): Extract<FinishOutboxInput, { outcome: "CONFIGURATION_FAILURE" }> {
  return {
    id: job.id,
    leaseToken: job.leaseToken,
    outcome: "CONFIGURATION_FAILURE",
    errorCode: "CONFIG_UNAUTHORIZED",
  };
}
const read = (id: string) => database.notificationOutbox.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  fixture = await createOutboxFixture(database);
});
beforeEach(() => {
  now = OUTBOX_NOW;
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fixture.cleanupJobs();
});
afterAll(async () => {
  await fixture?.cleanup();
  await database.$disconnect();
});

describe("Telegram PostgreSQL outbox lifecycle", () => {
  it("claims only due PENDING jobs, sets the whole lease and increments once", async () => {
    const due = await fixture.seed();
    const future = await fixture.seed({ nextAttemptAt: after(1) });
    for (const status of ["SENT", "DEAD", "CANCELLED", "SKIPPED"] as const) {
      await fixture.seed({
        status,
        finishedAt: OUTBOX_NOW,
        ...(status === "SENT" ? { sentAt: OUTBOX_NOW } : {}),
        ...(status === "CANCELLED"
          ? { invalidatedAt: OUTBOX_NOW, invalidationCode: "BOT_REPLACED" }
          : {}),
      });
    }
    const leaseOwner = owner();
    const jobs = await repository.claimDue({
      capacity: 20,
      leaseOwner: ` ${leaseOwner.toUpperCase()} `,
    });
    expect(jobs).toEqual([
      {
        id: due.id,
        type: due.type,
        attempts: 1,
        leaseToken: expect.any(String),
        leaseOwner,
        claimedAt: OUTBOX_NOW,
        leaseExpiresAt: after(60_000),
        expiresAt: null,
        invalidated: false,
        payloadCheck: { ok: true, payloadVersion: 1 },
      },
    ]);
    expect(jobs[0].leaseToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await read(future.id)).toMatchObject({ status: "PENDING", attempts: 0, ...noLease });
    expect(await repository.claimDue({ capacity: 20, leaseOwner })).toEqual([]);
    expect((await read(due.id)).attempts).toBe(1);
  });

  it("sorts by nextAttemptAt then id and caps claims at capacity and 20", async () => {
    const ids = Array.from({ length: 25 }, () => randomUUID()).sort();
    for (const id of [...ids].reverse()) await fixture.seed({ id, scheduledAt: after(-1000) });
    const earlier = await fixture.seed({ scheduledAt: after(-2000) });
    const first = await repository.claimDue({ capacity: 2, leaseOwner: owner() });
    expect(first.map((job) => job.id)).toEqual([earlier.id, ids[0]]);
    const batch = await repository.claimDue({ capacity: 100, leaseOwner: owner() });
    expect(batch.map((job) => job.id)).toEqual(ids.slice(1, 21));
    expect(new Set([...first, ...batch].map((job) => job.leaseToken)).size).toBe(22);
    expect(await repository.claimDue({ capacity: 0, leaseOwner: owner() })).toEqual([]);
    expect(await database.notificationOutbox.count({ where: { status: "PENDING" } })).toBe(4);
  });

  it("returns an empty list for an empty queue and never claims an exhausted external PENDING row", async () => {
    expect(await repository.claimDue({ capacity: 20, leaseOwner: owner() })).toEqual([]);
    await fixture.seed({ attempts: 6 });
    expect(await repository.claimDue({ capacity: 20, leaseOwner: owner() })).toEqual([]);
  });

  it("uses PostgreSQL time by default and releases the transaction before returning", async () => {
    const [start] = await database.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    await fixture.seed({ scheduledAt: new Date(start.now.getTime() - 1000) });
    const [job] = await new TelegramOutboxRepository(database).claimDue({
      capacity: 1,
      leaseOwner: owner(),
    });
    const [end] = await database.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    expect(job.claimedAt.getTime()).toBeGreaterThanOrEqual(start.now.getTime() - 1);
    expect(job.claimedAt.getTime()).toBeLessThanOrEqual(end.now.getTime() + 1);
    expect(job.leaseExpiresAt.getTime() - job.claimedAt.getTime()).toBe(60_000);
    expect((await read(job.id)).status).toBe("PROCESSING");
  });

  it("sends, clears retry errors and lease, and never changes a terminal row on repeat", async () => {
    await fixture.seed({ lastErrorCode: "TELEGRAM_5XX", attempts: 2 });
    const job = await claim();
    expect(await repository.finish(sent(job))).toEqual({ kind: "APPLIED", status: "SENT" });
    const terminal = await read(job.id);
    expect(terminal).toMatchObject({
      status: "SENT",
      attempts: 3,
      sentAt: now,
      finishedAt: now,
      lastErrorCode: null,
      ...noLease,
    });
    now = after(1000);
    expect(await repository.finish(retry(job))).toEqual({ kind: "TERMINAL", status: "SENT" });
    expect(await read(job.id)).toEqual(terminal);
  });

  it("retries using the pure helper, then sends with a new token and clears lastErrorCode", async () => {
    await fixture.seed();
    const job = await claim();
    expect(await repository.finish(retry(job))).toEqual({ kind: "APPLIED", status: "PENDING" });
    const decision = decideTelegramRetry({
      attempts: 1,
      errorCode: "TELEGRAM_5XX",
      clock: () => now,
      random: () => 0,
    });
    expect(decision.kind).toBe("RETRY");
    if (decision.kind !== "RETRY") throw new Error("Expected retry");
    expect(await read(job.id)).toMatchObject({
      status: "PENDING",
      attempts: 1,
      nextAttemptAt: decision.nextAttemptAt,
      lastErrorCode: "TELEGRAM_5XX",
      finishedAt: null,
      sentAt: null,
      ...noLease,
    });
    expect(await repository.claimDue({ capacity: 1, leaseOwner: owner() })).toEqual([]);
    now = decision.nextAttemptAt;
    const next = await claim();
    expect(next.leaseToken).not.toBe(job.leaseToken);
    expect(next.attempts).toBe(2);
    expect(await repository.finish(sent(next))).toMatchObject({ status: "SENT" });
    expect((await read(job.id)).lastErrorCode).toBeNull();
  });

  it.each([
    "INVALID_REQUEST",
    "CHAT_NOT_FOUND",
    "BOT_BLOCKED",
    "CHAT_WRITE_FORBIDDEN",
    "TELEGRAM_USER_DEACTIVATED",
    "PAYLOAD_VERSION_UNSUPPORTED",
    "RESPONSE_INVALID",
  ] as const)("permanent %s becomes DEAD without changing connections", async (errorCode) => {
    await fixture.seed();
    const job = await claim();
    expect(await repository.finish({ ...sent(job), outcome: "DEAD", errorCode })).toMatchObject({
      status: "DEAD",
    });
    expect(await read(job.id)).toMatchObject({
      status: "DEAD",
      attempts: 1,
      lastErrorCode: errorCode,
      finishedAt: now,
      sentAt: null,
      ...noLease,
    });
    expect(
      (
        await database.adminTelegramConnection.findUniqueOrThrow({
          where: { id: fixture.adminConnectionId },
        })
      ).disabledAt,
    ).toBeNull();
  });

  it.each(OUTBOX_SKIP_CODES)("worker skip %s clears lease and finishes", async (errorCode) => {
    await fixture.seed();
    const job = await claim();
    expect(await repository.finish({ ...sent(job), outcome: "SKIPPED", errorCode })).toMatchObject({
      status: "SKIPPED",
    });
    expect(await read(job.id)).toMatchObject({
      lastErrorCode: errorCode,
      finishedAt: now,
      sentAt: null,
      attempts: 1,
      ...noLease,
    });
  });

  it("sixth unsuccessful claim is DEAD while a sixth successful claim can be SENT", async () => {
    await fixture.seed({ attempts: 5 });
    const job = await claim();
    expect(job.attempts).toBe(6);
    expect(await repository.finish(retry(job))).toMatchObject({ status: "DEAD" });
    expect((await read(job.id)).attempts).toBe(6);
    await fixture.seed({ attempts: 5 });
    const success = await claim();
    expect(await repository.finish(sent(success))).toMatchObject({ status: "SENT" });
  });

  it.each([
    "NETWORK_UNREACHABLE",
    "DELIVERY_OUTCOME_UNKNOWN",
    "RESPONSE_INVALID",
    "RESPONSE_TOO_LARGE",
  ] as const)("%s retries without refund", async (errorCode) => {
    await fixture.seed();
    const job = await claim();
    expect(await repository.finish({ ...sent(job), outcome: "RETRY", errorCode })).toMatchObject({
      status: "PENDING",
    });
    expect((await read(job.id)).attempts).toBe(1);
  });

  it.each([
    [30, "PENDING"],
    [86_401, "DEAD"],
  ] as const)("handles retry_after=%i without early retry", async (retryAfterSeconds, status) => {
    await fixture.seed();
    const job = await claim();
    expect(
      await repository.finish({
        ...sent(job),
        outcome: "RETRY",
        errorCode: "TELEGRAM_RATE_LIMIT",
        retryAfterSeconds,
      }),
    ).toMatchObject({ status });
    if (status === "PENDING") expect((await read(job.id)).nextAttemptAt).toEqual(after(30_000));
  });

  it.each([0, 299_999, 300_001])(
    "does not retry past direct job expiry at offset %i",
    async (elapsed) => {
      await fixture.seed({ type: "TELEGRAM_CONNECTION_REJECTED" });
      now = after(elapsed);
      const job = await claim();
      const expected = elapsed === 0 ? "PENDING" : "SKIPPED";
      expect(await repository.finish(retry(job))).toMatchObject({ status: expected });
      const row = await read(job.id);
      expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(row.expiresAt!.getTime());
      expect(row.attempts).toBe(1);
    },
  );

  it.each(OUTBOX_INVALIDATION_CODES)(
    "invalidation %s cancels PENDING and preserves PROCESSING lease, first invalidation wins",
    async (code) => {
      const processing = await fixture.seed();
      const job = await claim();
      const pending = await fixture.seed();
      const before = await read(processing.id);
      const input = {
        target: { kind: "ADMIN_CONNECTION" as const, id: fixture.adminConnectionId },
        code,
        now,
      };
      expect(await database.$transaction((tx) => invalidateTelegramOutbox(tx, input))).toEqual({
        cancelled: 1,
        invalidated: 1,
      });
      expect(await read(pending.id)).toMatchObject({
        status: "CANCELLED",
        invalidatedAt: now,
        invalidationCode: code,
        finishedAt: now,
        ...noLease,
      });
      expect(await read(processing.id)).toEqual({
        ...before,
        invalidatedAt: now,
        invalidationCode: code,
        updatedAt: now,
      });
      now = after(1000);
      expect(
        await invalidateTelegramOutbox(database, { ...input, code: "BOT_REPLACED", now }),
      ).toEqual({ cancelled: 0, invalidated: 0 });
      expect(await repository.finish(retry(job))).toMatchObject({ status: "SKIPPED" });
      expect((await read(job.id)).invalidationCode).toBe(code);
    },
  );

  it("invalidation uses an exact appointment/type filter and client connection target", async () => {
    const reminder = await fixture.seed({ type: "CLIENT_APPOINTMENT_REMINDER" });
    const confirmed = await fixture.seed({ type: "CLIENT_CONNECTION_CONFIRMED" });
    const admin = await fixture.seed();
    expect(
      await invalidateTelegramOutbox(database, {
        target: {
          kind: "APPOINTMENT",
          id: fixture.appointmentId,
          types: ["CLIENT_APPOINTMENT_REMINDER"],
        },
        code: "VISIT_CHANGED",
        now,
      }),
    ).toEqual({ cancelled: 1, invalidated: 0 });
    expect((await read(reminder.id)).status).toBe("CANCELLED");
    expect((await read(confirmed.id)).status).toBe("PENDING");
    expect(
      await invalidateTelegramOutbox(database, {
        target: { kind: "APPOINTMENT_CONNECTION", id: fixture.clientConnectionId },
        code: "CONNECTION_DISABLED",
        now,
      }),
    ).toEqual({ cancelled: 1, invalidated: 0 });
    expect((await read(admin.id)).status).toBe("PENDING");
  });

  it("confirmed success wins over invalidation; all terminal rows stay immutable", async () => {
    for (const outcome of ["SENT", "DEAD", "SKIPPED"] as const) {
      await fixture.seed();
      const job = await claim();
      if (outcome === "SENT") {
        await invalidateTelegramOutbox(database, {
          target: { kind: "ADMIN_CONNECTION", id: fixture.adminConnectionId },
          code: "CONNECTION_DISABLED",
          now,
        });
      }
      const command: FinishOutboxInput =
        outcome === "SENT"
          ? sent(job)
          : outcome === "DEAD"
            ? { ...sent(job), outcome, errorCode: "INVALID_REQUEST" }
            : { ...sent(job), outcome, errorCode: "CONNECTION_INACTIVE" };
      expect(await repository.finish(command)).toEqual({ kind: "APPLIED", status: outcome });
      if (outcome === "SENT") {
        expect(await read(job.id)).toMatchObject({
          status: "SENT",
          attempts: 1,
          sentAt: now,
          finishedAt: now,
          lastErrorCode: null,
          invalidatedAt: now,
          invalidationCode: "CONNECTION_DISABLED",
          ...noLease,
        });
      }
    }
    await fixture.seed({
      status: "CANCELLED",
      finishedAt: now,
      invalidatedAt: now,
      invalidationCode: "BOT_REPLACED",
    });
    const before = await database.notificationOutbox.findMany({ orderBy: { id: "asc" } });
    now = after(1);
    expect(
      await invalidateTelegramOutbox(database, {
        target: { kind: "ADMIN_CONNECTION", id: fixture.adminConnectionId },
        code: "BOT_REPLACED",
        now,
      }),
    ).toEqual({ cancelled: 0, invalidated: 0 });
    for (const row of before)
      expect(
        await repository.finish({ id: row.id, leaseToken: randomUUID(), outcome: "SENT" }),
      ).toEqual({ kind: "TERMINAL", status: row.status });
    expect(await database.notificationOutbox.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });

  it.each(["RETRY", "DEAD"] as const)("invalidated %s outcome becomes SKIPPED", async (outcome) => {
    await fixture.seed();
    const job = await claim();
    await invalidateTelegramOutbox(database, {
      target: { kind: "ADMIN_CONNECTION", id: fixture.adminConnectionId },
      code: "CONNECTION_DISABLED",
      now,
    });
    const command: FinishOutboxInput =
      outcome === "RETRY"
        ? { ...retry(job), errorCode: "DELIVERY_OUTCOME_UNKNOWN" }
        : { ...sent(job), outcome, errorCode: "INVALID_REQUEST" };
    expect(await repository.finish(command)).toMatchObject({ status: "SKIPPED" });
    expect(await read(job.id)).toMatchObject({
      lastErrorCode: "CONNECTION_INACTIVE",
      attempts: 1,
      finishedAt: now,
      ...noLease,
    });
  });

  it.each([
    ["CONNECTION_DISABLED", "CONNECTION_INACTIVE"],
    ["VISIT_CHANGED", "VISIT_MISMATCH"],
  ] as const)(
    "invalidated configuration failure refunds the attempt and uses %s business reason",
    async (invalidationCode, lastErrorCode) => {
      await fixture.seed({ attempts: 2 });
      const job = await claim();
      expect(job.expiresAt).toBeNull();
      await invalidateTelegramOutbox(database, {
        target: { kind: "ADMIN_CONNECTION", id: fixture.adminConnectionId },
        code: invalidationCode,
        now,
      });
      const invalidated = await read(job.id);

      expect(await repository.finish(configuration(job))).toEqual({
        kind: "APPLIED",
        status: "SKIPPED",
      });
      expect(await read(job.id)).toMatchObject({
        status: "SKIPPED",
        attempts: 2,
        nextAttemptAt: invalidated.nextAttemptAt,
        lastErrorCode,
        invalidatedAt: invalidated.invalidatedAt,
        invalidationCode,
        finishedAt: now,
        sentAt: null,
        ...noLease,
      });
      expect(await repository.claimDue({ capacity: 20, leaseOwner: owner() })).toEqual([]);
    },
  );

  it.each(["TELEGRAM_CONNECTION_REJECTED", "CLIENT_APPOINTMENT_REMINDER"] as const)(
    "configuration compensation obeys exact expiry and +1ms for %s",
    async (type) => {
      for (const overrun of [0, 1]) {
        const row = await fixture.seed({ type, attempts: 2 });
        now = new Date(row.expiresAt!.getTime() - 5 * 60_000 + overrun);
        const job = await claim();
        const before = await read(job.id);
        expect(
          await repository.finish({ ...configuration(job), leaseToken: randomUUID() }),
        ).toEqual({ kind: "LEASE_LOST" });
        expect(await read(job.id)).toEqual(before);
        const status = overrun === 0 ? "PENDING" : "SKIPPED";
        expect(await repository.finish(configuration(job))).toEqual({ kind: "APPLIED", status });
        const result = await read(job.id);
        expect(result).toMatchObject({
          status,
          attempts: 2,
          lastErrorCode: "CONFIG_UNAUTHORIZED",
          nextAttemptAt: overrun === 0 ? row.expiresAt : row.nextAttemptAt,
          finishedAt: overrun === 0 ? null : now,
          sentAt: null,
          invalidatedAt: null,
          invalidationCode: null,
          ...noLease,
        });
        expect(result.nextAttemptAt.getTime()).toBeLessThanOrEqual(result.expiresAt!.getTime());
        await database.notificationOutbox.delete({ where: { id: job.id } });
      }
    },
  );

  it("configuration compensation without a deadline refunds once, including zero lower bound", async () => {
    for (const attempts of [0, 1, 6]) {
      const token = randomUUID();
      const row = await fixture.seed({
        status: "PROCESSING",
        attempts,
        leaseToken: token,
        leaseOwner: owner(),
        claimedAt: now,
        leaseExpiresAt: after(60_000),
      });
      const command: FinishOutboxInput = {
        id: row.id,
        leaseToken: token,
        outcome: "CONFIGURATION_FAILURE",
        errorCode: "CONFIG_UNAUTHORIZED",
      };
      expect(await repository.finish(command)).toMatchObject({ status: "PENDING" });
      const pending = await read(row.id);
      expect(pending).toMatchObject({
        attempts: Math.max(0, attempts - 1),
        nextAttemptAt: after(300_000),
        lastErrorCode: "CONFIG_UNAUTHORIZED",
        sentAt: null,
        finishedAt: null,
        ...noLease,
      });
      expect(await repository.finish(command)).toEqual({ kind: "TRANSITION_NOT_ALLOWED" });
      expect(await read(row.id)).toEqual(pending);
    }
  });

  it("recovers only expired leases with pure backoff and preserves attempts", async () => {
    await fixture.seed();
    const job = await claim();
    now = after(59_999);
    expect(await repository.recoverExpired({ batchSize: 20 })).toEqual([]);
    now = after(60_000);
    expect(await repository.recoverExpired({ batchSize: 20 })).toEqual([
      { id: job.id, status: "PENDING" },
    ]);
    const decision = decideTelegramRetry({
      attempts: 1,
      errorCode: "DELIVERY_OUTCOME_UNKNOWN",
      clock: () => now,
      random: () => 0,
    });
    if (decision.kind !== "RETRY") throw new Error("Expected retry");
    expect(await read(job.id)).toMatchObject({
      attempts: 1,
      nextAttemptAt: decision.nextAttemptAt,
      lastErrorCode: "DELIVERY_OUTCOME_UNKNOWN",
      finishedAt: null,
      sentAt: null,
      ...noLease,
    });
    const before = await read(job.id);
    expect(await repository.recoverExpired({ batchSize: 20 })).toEqual([]);
    expect(await read(job.id)).toEqual(before);
  });

  it.each(["sixth", "invalidated", "expired", "retry-past-expiry"] as const)(
    "recovery handles %s",
    async (scenario) => {
      const row = await fixture.seed({
        attempts: 5,
        ...(scenario === "expired" || scenario === "retry-past-expiry"
          ? { type: "TELEGRAM_CONNECTION_REJECTED" as const }
          : {}),
      });
      // Exhaustion is tested separately; current jobs start at attempt 1 for expiry decisions.
      if (scenario !== "sixth")
        await database.notificationOutbox.update({ where: { id: row.id }, data: { attempts: 0 } });
      const job = await claim();
      if (scenario === "invalidated")
        await invalidateTelegramOutbox(database, {
          target: { kind: "ADMIN_CONNECTION", id: fixture.adminConnectionId },
          code: "BOT_REPLACED",
          now,
        });
      now = after(
        scenario === "expired" ? 300_001 : scenario === "retry-past-expiry" ? 299_999 : 60_000,
      );
      const status = scenario === "sixth" ? "DEAD" : "SKIPPED";
      expect(await repository.recoverExpired({ batchSize: 20 })).toEqual([{ id: job.id, status }]);
      expect(await read(job.id)).toMatchObject({
        status,
        attempts: scenario === "sixth" ? 6 : 1,
        finishedAt: now,
        sentAt: null,
        ...noLease,
      });
    },
  );

  it("recovery is bounded at 20 and respects a smaller batch", async () => {
    for (let i = 0; i < 24; i++)
      await fixture.seed({
        status: "PROCESSING",
        attempts: 1,
        leaseToken: randomUUID(),
        leaseOwner: owner(),
        claimedAt: after(-60_000),
        leaseExpiresAt: now,
      });
    expect(await repository.recoverExpired({ batchSize: 1 })).toHaveLength(1);
    expect(await repository.recoverExpired({ batchSize: 100 })).toHaveLength(20);
    expect(await repository.recoverExpired({ batchSize: 20 })).toHaveLength(3);
    expect(await repository.recoverExpired({ batchSize: 20 })).toEqual([]);
  });

  it("reports invalid payload/version safely and permits fenced DEAD", async () => {
    const canary = `payload-${randomUUID()}`;
    for (const [payloadVersion, payload, code] of [
      [2, {}, "PAYLOAD_VERSION_UNSUPPORTED"],
      [1, { token: canary }, "RESPONSE_INVALID"],
      [1, [], "RESPONSE_INVALID"],
      [1, "broken", "RESPONSE_INVALID"],
    ] as const) {
      await fixture.seed({
        type: "TELEGRAM_CONNECTION_REJECTED",
        payloadVersion,
        payload: payload as never,
      });
      const job = await claim();
      expect(job.payloadCheck).toEqual({ ok: false, code });
      expect(JSON.stringify(job)).not.toContain(canary);
      expect(job).not.toHaveProperty("payload");
      expect(job).not.toHaveProperty("directChatId");
      expect(
        await repository.finish({ ...sent(job), outcome: "DEAD", errorCode: code }),
      ).toMatchObject({ status: "DEAD" });
    }
  });

  it("a failure after real claim SQL rolls back all rows and removes unsafe error details", async () => {
    const rows = await Promise.all([fixture.seed(), fixture.seed()]);
    const canary = `raw-error-${randomUUID()}`;
    const faulting = beforeCommitClient(database, async (tx) => {
      expect(await tx.notificationOutbox.count({ where: { status: "PROCESSING" } })).toBe(2);
      throw new Error(canary);
    });
    const broken = new TelegramOutboxRepository(faulting, { clock: () => now });
    const error = await broken
      .claimDue({ capacity: 2, leaseOwner: owner() })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "OUTBOX_STORAGE_FAILURE" });
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(String(error)).not.toContain(canary);
    for (const row of rows) expect(await read(row.id)).toEqual(row);
  });

  it("caller rollback also rolls back invalidation", async () => {
    const row = await fixture.seed();
    await expect(
      database.$transaction(async (tx) => {
        await invalidateTelegramOutbox(tx, {
          target: { kind: "ADMIN_CONNECTION", id: fixture.adminConnectionId },
          code: "BOT_REPLACED",
          now,
        });
        throw new Error("Expected transaction rollback");
      }),
    ).rejects.toThrow("Expected transaction rollback");
    expect(await read(row.id)).toEqual(row);
  });

  it("valid snapshot payload and recipient canaries never escape in the claim DTO", async () => {
    const canaries = [
      `token-${randomUUID()}`,
      `https://example.invalid/${randomUUID()}`,
      "+79991234567",
      fixture.externalId.toString(),
      `c_${randomUUID()}`,
    ];
    const row = await fixture.seed({
      type: "ADMIN_APPOINTMENT_CREATED",
      payload: {
        source: "ADMIN",
        appointmentVersion: 0,
        occurredAt: now.toISOString(),
        visit: {
          serviceId: randomUUID(),
          masterId: randomUUID(),
          startsAt: after(60_000).toISOString(),
          endsAt: after(120_000).toISOString(),
          durationMinutes: 1,
          businessTimeZone: "Europe/Moscow",
          serviceName: canaries.join(" | "),
          masterName: "Fixture master",
        },
      },
    });
    const job = await claim();
    expect(job.id).toBe(row.id);
    expect(job.payloadCheck).toEqual({ ok: true, payloadVersion: 1 });
    for (const canary of canaries) expect(JSON.stringify(job)).not.toContain(canary);
    expect(job).not.toHaveProperty("payload");
    expect(job).not.toHaveProperty("adminConnectionId");
    expect(job).not.toHaveProperty("dedupeKey");
  });

  it("retry accepts the exact deadline and skips the next millisecond without violating schedule", async () => {
    for (const offset of [285_000, 285_001]) {
      await fixture.seed({ type: "TELEGRAM_CONNECTION_REJECTED" });
      now = after(offset);
      const job = await claim();
      const status = offset === 285_000 ? "PENDING" : "SKIPPED";
      expect(await repository.finish(retry(job))).toEqual({ kind: "APPLIED", status });
      const row = await read(job.id);
      expect(row.nextAttemptAt).toEqual(offset === 285_000 ? after(300_000) : OUTBOX_NOW);
      expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(row.expiresAt!.getTime());
      await database.notificationOutbox.delete({ where: { id: job.id } });
      now = OUTBOX_NOW;
    }
  });

  it("does not finalize using an injected clock earlier than the claim", async () => {
    await fixture.seed();
    const job = await claim();
    const before = await read(job.id);
    now = after(-1);
    expect(await repository.finish(configuration(job))).toEqual({ kind: "TRANSITION_NOT_ALLOWED" });
    expect(await read(job.id)).toEqual(before);
  });

  it("rejects invalid UUID, code, owner, date and capacity before SQL without canary leakage", async () => {
    const row = await fixture.seed();
    const canary = `secret-${randomUUID()}`;
    const rawLink = `c_${randomUUID().replaceAll("-", "")}`;
    const canaries = [
      canary,
      rawLink,
      `https://example.invalid/${canary}`,
      "+79991234567",
      fixture.externalId.toString(),
    ];
    const calls = vi.spyOn(database, "$transaction");
    const rawCalls = vi.spyOn(database, "$queryRaw");
    for (const value of canaries) {
      for (const run of [
        () => repository.claimDue({ capacity: 1, leaseOwner: value }),
        () => repository.finish({ id: value, leaseToken: randomUUID(), outcome: "SENT" }),
        () => repository.finish({ id: row.id, leaseToken: value, outcome: "SENT" }),
        () =>
          repository.finish({
            id: row.id,
            leaseToken: randomUUID(),
            outcome: "DEAD",
            errorCode: value,
          } as never),
        () =>
          invalidateTelegramOutbox(database, {
            target: { kind: "ADMIN_CONNECTION", id: fixture.adminConnectionId },
            code: value,
            now,
          } as never),
      ]) {
        const error = await run().catch((error: unknown) => error);
        expect(error).toMatchObject({ code: "OUTBOX_INPUT_INVALID" });
        for (const secret of canaries) expect(JSON.stringify(error)).not.toContain(secret);
      }
    }
    for (const capacity of [-1, 1.5, NaN, Infinity])
      await expect(repository.claimDue({ capacity, leaseOwner: owner() })).rejects.toMatchObject({
        code: "OUTBOX_INPUT_INVALID",
      });
    await expect(
      new TelegramOutboxRepository(database, { clock: () => new Date(NaN) }).claimDue({
        capacity: 1,
        leaseOwner: owner(),
      }),
    ).rejects.toMatchObject({ code: "OUTBOX_INPUT_INVALID" });
    await expect(
      invalidateTelegramOutbox(database, {
        target: { kind: "ADMIN_CONNECTION", id: fixture.adminConnectionId },
        code: "BOT_REPLACED",
        now: new Date(NaN),
      }),
    ).rejects.toMatchObject({ code: "OUTBOX_INPUT_INVALID" });
    expect(calls).not.toHaveBeenCalled();
    expect(rawCalls).not.toHaveBeenCalled();
    expect(await read(row.id)).toEqual(row);
  });
});
