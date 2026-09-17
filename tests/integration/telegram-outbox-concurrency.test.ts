import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import {
  TelegramOutboxRepository,
  invalidateTelegramOutbox,
} from "../../src/modules/telegram/server/outbox-repository";
import type { FinishOutboxInput } from "../../src/modules/telegram/server/outbox-contract";
import {
  OUTBOX_NOW,
  after,
  beforeCommitClient,
  bounded,
  createOutboxFixture,
  deferred,
  isolatedOutboxDatabaseUrl,
  owner,
} from "./telegram-outbox-fixture";

const url = isolatedOutboxDatabaseUrl();
const first = createPrismaClient(url);
const second = createPrismaClient(url);
const blocker = new pg.Client({
  connectionString: url,
  statement_timeout: 4000,
  query_timeout: 5000,
});
let fixture: Awaited<ReturnType<typeof createOutboxFixture>>;
let now = OUTBOX_NOW;
const options = { clock: () => now, random: () => 0 };
const a = new TelegramOutboxRepository(first, options);
const b = new TelegramOutboxRepository(second, options);
const claimInput = () => ({ capacity: 20, leaseOwner: owner() });
const read = (id: string) => second.notificationOutbox.findUniqueOrThrow({ where: { id } });
const forbiddenFetch = vi.fn(() => {
  throw new Error("External network is forbidden");
});

beforeAll(async () => {
  await Promise.all([first.$connect(), second.$connect(), blocker.connect()]);
  const [[one], [two]] = await Promise.all([
    first.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`,
    second.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`,
  ]);
  expect(one.pid).not.toBe(two.pid);
  fixture = await createOutboxFixture(first);
});
beforeEach(() => {
  now = OUTBOX_NOW;
  vi.stubGlobal("fetch", forbiddenFetch);
});
afterEach(async () => {
  await blocker.query("ROLLBACK");
  expect(forbiddenFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await fixture.cleanupJobs();
  await Promise.all([
    first.appointmentTelegramConnection.update({
      where: { id: fixture.clientConnectionId },
      data: { disabledAt: null, disabledReason: null },
    }),
    first.adminTelegramConnection.update({
      where: { id: fixture.adminConnectionId },
      data: { disabledAt: null, disabledReason: null },
    }),
  ]);
});
afterAll(async () => {
  await fixture?.cleanup();
  await Promise.all([first.$disconnect(), second.$disconnect(), blocker.end()]);
});

describe("Telegram PostgreSQL concurrency with independent connections", () => {
  it("two dispatchers never receive the same job, including while the first claim is uncommitted", async () => {
    const row = await fixture.seed();
    const holding = deferred();
    const release = deferred();
    const held = new TelegramOutboxRepository(
      beforeCommitClient(first, async () => {
        holding.resolve();
        await bounded(release.promise);
      }),
      options,
    );
    const claiming = held.claimDue(claimInput());
    try {
      await bounded(holding.promise);
      expect(await bounded(b.claimDue(claimInput()))).toEqual([]);
      // The other connection still sees the old PENDING version until COMMIT.
      expect((await read(row.id)).status).toBe("PENDING");
    } finally {
      release.resolve();
      await claiming;
    }
    expect(await claiming).toHaveLength(1);
    expect((await read(row.id)).attempts).toBe(1);
  }, 10_000);

  it("simultaneous claims split the queue with no duplicates or extra attempts", async () => {
    for (let i = 0; i < 30; i++) await fixture.seed();
    const [left, right] = await bounded(
      Promise.all([a.claimDue(claimInput()), b.claimDue(claimInput())]),
    );
    const jobs = [...left, ...right];
    expect(left.length).toBeLessThanOrEqual(20);
    expect(right.length).toBeLessThanOrEqual(20);
    expect(jobs).toHaveLength(30);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(30);
    expect(new Set(jobs.map((job) => job.leaseToken)).size).toBe(30);
    expect(jobs.every((job) => job.attempts === 1)).toBe(true);
  }, 10_000);

  it("SKIP LOCKED processes an available job before another connection releases the older job", async () => {
    const locked = await fixture.seed({ scheduledAt: after(-1000) });
    const available = await fixture.seed();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM notification_outbox WHERE id = $1 FOR UPDATE", [locked.id]);
    const jobs = await bounded(b.claimDue(claimInput()));
    expect(jobs.map((job) => job.id)).toEqual([available.id]);
    expect(await read(locked.id)).toEqual(locked);
    await blocker.query("COMMIT");
    expect((await a.claimDue(claimInput())).map((job) => job.id)).toEqual([locked.id]);
  }, 10_000);

  it("an expired or replaced lease cannot apply any finalization or touch the new lease", async () => {
    await fixture.seed();
    const [old] = await a.claimDue(claimInput());
    now = after(60_000);
    expect(await b.finish({ id: old.id, leaseToken: old.leaseToken, outcome: "SENT" })).toEqual({
      kind: "LEASE_LOST",
    });
    expect(await b.recoverExpired({ batchSize: 20 })).toEqual([{ id: old.id, status: "PENDING" }]);
    now = after(75_000);
    const [current] = await b.claimDue(claimInput());
    expect(current.leaseToken).not.toBe(old.leaseToken);
    expect(current.attempts).toBe(2);
    const before = await read(old.id);
    const commands: FinishOutboxInput[] = [
      { id: old.id, leaseToken: old.leaseToken, outcome: "SENT" },
      {
        id: old.id,
        leaseToken: old.leaseToken,
        outcome: "RETRY",
        errorCode: "DELIVERY_OUTCOME_UNKNOWN",
      },
      { id: old.id, leaseToken: old.leaseToken, outcome: "DEAD", errorCode: "INVALID_REQUEST" },
      {
        id: old.id,
        leaseToken: old.leaseToken,
        outcome: "SKIPPED",
        errorCode: "CONNECTION_INACTIVE",
      },
      {
        id: old.id,
        leaseToken: old.leaseToken,
        outcome: "CONFIGURATION_FAILURE",
        errorCode: "CONFIG_UNAUTHORIZED",
      },
    ];
    for (const command of commands) {
      expect(await a.finish(command)).toEqual({ kind: "LEASE_LOST" });
      expect(await read(old.id)).toEqual(before);
    }
    expect(
      await b.finish({ id: current.id, leaseToken: current.leaseToken, outcome: "SENT" }),
    ).toEqual({ kind: "APPLIED", status: "SENT" });
  }, 10_000);

  it("concurrent finalization of one lease applies once and then reports terminal", async () => {
    await fixture.seed();
    const [job] = await a.claimDue(claimInput());
    const command: FinishOutboxInput = { id: job.id, leaseToken: job.leaseToken, outcome: "SENT" };
    const results = await bounded(Promise.all([a.finish(command), b.finish(command)]));
    expect(results).toContainEqual({ kind: "APPLIED", status: "SENT" });
    expect(results).toContainEqual({ kind: "TERMINAL", status: "SENT" });
    expect(await read(job.id)).toMatchObject({
      attempts: 1,
      status: "SENT",
      sentAt: now,
      finishedAt: now,
    });
  }, 10_000);

  it("two recovery workers do not restore the same job even before COMMIT", async () => {
    for (let i = 0; i < 2; i++) await fixture.seed();
    const claimed = await a.claimDue(claimInput());
    now = after(60_000);
    const holding = deferred();
    const release = deferred();
    const held = new TelegramOutboxRepository(
      beforeCommitClient(first, async () => {
        holding.resolve();
        await bounded(release.promise);
      }),
      options,
    );
    const recovering = held.recoverExpired({ batchSize: 1 });
    let other: Awaited<ReturnType<typeof b.recoverExpired>> = [];
    try {
      await bounded(holding.promise);
      other = await bounded(b.recoverExpired({ batchSize: 20 }));
      expect(other).toHaveLength(1);
    } finally {
      release.resolve();
      await recovering;
    }
    const own = await recovering;
    expect(own).toHaveLength(1);
    expect(own[0].id).not.toBe(other[0].id);
    expect(new Set([...own, ...other].map((job) => job.id))).toEqual(
      new Set(claimed.map((job) => job.id)),
    );
    expect(await b.recoverExpired({ batchSize: 20 })).toEqual([]);
    for (const job of claimed)
      expect(await read(job.id)).toMatchObject({
        attempts: 1,
        status: "PENDING",
        nextAttemptAt: after(75_000),
        leaseToken: null,
      });
  }, 10_000);

  it("recovery also skips a locked expired lease and leaves a live lease unchanged", async () => {
    for (let i = 0; i < 3; i++) await fixture.seed();
    const jobs = await a.claimDue(claimInput());
    await first.notificationOutbox.update({
      where: { id: jobs[2].id },
      data: { leaseExpiresAt: after(90_000) },
    });
    now = after(60_000);
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM notification_outbox WHERE id = $1 FOR UPDATE", [
      jobs[0].id,
    ]);
    expect(await bounded(b.recoverExpired({ batchSize: 20 }))).toEqual([
      { id: jobs[1].id, status: "PENDING" },
    ]);
    expect((await read(jobs[0].id)).status).toBe("PROCESSING");
    expect((await read(jobs[2].id)).status).toBe("PROCESSING");
  }, 10_000);

  it("producer invalidation during a held claim preserves its token; unknown outcome is not retried", async () => {
    await fixture.seed();
    const holding = deferred();
    const release = deferred();
    const held = new TelegramOutboxRepository(
      beforeCommitClient(first, async () => {
        holding.resolve();
        await bounded(release.promise);
      }),
      options,
    );
    const claiming = held.claimDue(claimInput());
    let invalidating: ReturnType<typeof invalidateTelegramOutbox> | undefined;
    try {
      await bounded(holding.promise);
      invalidating = invalidateTelegramOutbox(second, {
        target: { kind: "ADMIN_CONNECTION", id: fixture.adminConnectionId },
        code: "CONNECTION_DISABLED",
        now,
      });
    } finally {
      release.resolve();
    }
    const [job] = await bounded(claiming);
    expect(await bounded(invalidating!)).toEqual({ cancelled: 0, invalidated: 1 });
    expect(await read(job.id)).toMatchObject({
      status: "PROCESSING",
      leaseToken: job.leaseToken,
      attempts: 1,
      invalidatedAt: now,
    });
    expect(
      await a.finish({
        id: job.id,
        leaseToken: job.leaseToken,
        outcome: "RETRY",
        errorCode: "DELIVERY_OUTCOME_UNKNOWN",
      }),
    ).toEqual({ kind: "APPLIED", status: "SKIPPED" });
  }, 10_000);

  it.each(["TELEGRAM_CONNECTION_REJECTED", "CLIENT_APPOINTMENT_REMINDER"] as const)(
    "reclaimed %s rejects stale configuration compensation after recovery",
    async (type) => {
      for (const delta of [0, 1]) {
        const row = await fixture.seed({ type });
        const [old] = await a.claimDue(claimInput());
        now = new Date(now.getTime() + 60_000);
        await b.recoverExpired({ batchSize: 20 });
        now = new Date(
          Math.max(
            (await read(row.id)).nextAttemptAt.getTime(),
            row.expiresAt!.getTime() - 300_000 + delta,
          ),
        );
        const [current] = await b.claimDue(claimInput());
        expect(current).toBeDefined();
        const before = await read(row.id);
        expect(
          await a.finish({
            id: row.id,
            leaseToken: old.leaseToken,
            outcome: "CONFIGURATION_FAILURE",
            errorCode: "CONFIG_UNAUTHORIZED",
          }),
        ).toEqual({ kind: "LEASE_LOST" });
        expect(await read(row.id)).toEqual(before);
        await first.notificationOutbox.delete({ where: { id: row.id } });
        now = OUTBOX_NOW;
      }
    },
    10_000,
  );

  it("serializes simultaneous permanent failures without deadlock or reason overwrite", async () => {
    const foreign = await fixture.seed({
      type: "TELEGRAM_CONNECTION_REJECTED",
      scheduledAt: after(1000),
    });
    await Promise.all([fixture.seed(), fixture.seed()]);
    const jobs = await a.claimDue(claimInput());
    expect(jobs).toHaveLength(2);

    const results = await bounded(
      Promise.all([
        a.finish({
          id: jobs[0].id,
          leaseToken: jobs[0].leaseToken,
          outcome: "DEAD",
          errorCode: "CHAT_NOT_FOUND",
        }),
        b.finish({
          id: jobs[1].id,
          leaseToken: jobs[1].leaseToken,
          outcome: "DEAD",
          errorCode: "BOT_BLOCKED",
        }),
      ]),
      5000,
    );

    expect(results).toContainEqual({ kind: "APPLIED", status: "DEAD" });
    expect(results).toContainEqual({ kind: "APPLIED", status: "SKIPPED" });
    const connection = await second.adminTelegramConnection.findUniqueOrThrow({
      where: { id: fixture.adminConnectionId },
    });
    expect(["CHAT_NOT_FOUND", "BOT_BLOCKED"]).toContain(connection.disabledReason);
    expect(connection.disabledAt).toEqual(now);
    expect(await read(foreign.id)).toEqual(foreign);
    const stored = await Promise.all(jobs.map((job) => read(job.id)));
    expect(stored.map((job) => job.status).sort()).toEqual(["DEAD", "SKIPPED"]);
    expect(stored.find((job) => job.status === "DEAD")).toMatchObject({
      lastErrorCode: connection.disabledReason,
      leaseToken: null,
    });
    expect(stored.find((job) => job.status === "SKIPPED")).toMatchObject({
      invalidationCode: "CONNECTION_DISABLED",
      lastErrorCode: "CONNECTION_INACTIVE",
      leaseToken: null,
    });
  }, 10_000);

  it("missing and non-processing rows have controlled outcomes", async () => {
    expect(await a.finish({ id: randomUUID(), leaseToken: randomUUID(), outcome: "SENT" })).toEqual(
      { kind: "LEASE_LOST" },
    );
    const row = await fixture.seed();
    expect(await b.finish({ id: row.id, leaseToken: randomUUID(), outcome: "SENT" })).toEqual({
      kind: "TRANSITION_NOT_ALLOWED",
    });
    expect(await read(row.id)).toEqual(row);
  });
});
