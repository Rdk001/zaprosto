import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { hashTelegramLinkToken } from "../../src/modules/telegram/domain/link-token";
import { AdminTelegramRepository } from "../../src/modules/telegram/server/admin-connection-repository";
import { AdminTelegramService } from "../../src/modules/telegram/server/admin-connection-service";
import { processTelegramStart } from "../../src/modules/telegram/server/start-processor";
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
let external = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`) + 90_000n;
const directChats = new Set<bigint>();
const forbiddenFetch = vi.fn(() => {
  throw new Error("External Telegram network is forbidden");
});

function service(
  client: PrismaClient = database,
  options: ConstructorParameters<typeof AdminTelegramRepository>[2] = {},
) {
  return new AdminTelegramService(
    client,
    new AdminTelegramRepository(client, LINK_CONFIGURATION, options),
  );
}

function raw(result: Awaited<ReturnType<ReturnType<typeof createLinkService>["issueAdminLink"]>>) {
  if (!result.ok) throw new Error("Expected issued admin link");
  const value = new URL(result.deepLink).searchParams.get("start");
  if (!value) throw new Error("Expected admin start parameter");
  return value;
}

async function start(client: PrismaClient, startParameter: string) {
  const hashed = hashTelegramLinkToken(startParameter);
  if (!hashed.ok || hashed.purpose !== "ADMIN_USER")
    throw new Error("Expected valid admin start parameter");
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
        purpose: "ADMIN_USER",
        tokenHash: hashed.hash,
      }),
    { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 },
  );
}

async function job(input: { connectionId: string; status?: "PENDING" | "PROCESSING" | "SENT" }) {
  const now = new Date();
  const processing =
    input.status === "PROCESSING"
      ? {
          attempts: 1,
          leaseToken: randomUUID(),
          leaseOwner: "telegram-admin-connection-test",
          claimedAt: now,
          leaseExpiresAt: new Date(now.getTime() + 60_000),
        }
      : {};
  return database.notificationOutbox.create({
    data: {
      recipientKind: "ADMIN_CONNECTION",
      adminConnectionId: input.connectionId,
      type: "ADMIN_CONNECTION_CONFIRMED",
      status: input.status ?? "PENDING",
      scheduledAt: now,
      nextAttemptAt: now,
      payload: {},
      dedupeKey: `telegram-admin-connection-test-${randomUUID()}`,
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

describe("Admin Telegram state and disconnect", () => {
  it("returns AVAILABLE without rate-limit consumption and CONNECTED before readiness", async () => {
    const admin = await fixture.admin();
    await expect(service().getState(admin.token)).resolves.toEqual({
      ok: true,
      state: "AVAILABLE",
    });
    expect(await database.publicRateLimit.count()).toBe(0);

    const disabled = new AdminTelegramService(
      database,
      new AdminTelegramRepository(database, { kind: "DISABLED" }),
    );
    await expect(disabled.getState(admin.token)).resolves.toEqual({
      ok: true,
      state: "UNAVAILABLE",
    });
    await database.telegramBotState.update({
      where: { id: 1 },
      data: { lastPollAt: new Date("2000-01-01T00:00:00.000Z") },
    });
    await expect(service().getState(admin.token)).resolves.toEqual({
      ok: true,
      state: "UNAVAILABLE",
    });

    await fixture.adminConnection(admin.id);
    await expect(disabled.getState(admin.token)).resolves.toEqual({
      ok: true,
      state: "CONNECTED",
    });
  });

  it("returns UNAUTHORIZED for invalid, expired, revoked and inactive sessions", async () => {
    await expect(service().getState("invalid")).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
    for (const mode of ["EXPIRED", "REVOKED"] as const) {
      const admin = await fixture.admin({ session: mode });
      await expect(service().getState(admin.token)).resolves.toEqual({
        ok: false,
        code: "UNAUTHORIZED",
      });
      await expect(service().disconnect(admin.token)).resolves.toEqual({
        ok: false,
        code: "UNAUTHORIZED",
      });
    }

    const inactive = await fixture.admin({ isActive: false });
    const links = createLinkService(database);
    await expect(service().getState(inactive.token)).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
    await expect(links.issueAdminLink(inactive.token)).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
    await expect(links.revokeAdminLink(inactive.token)).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
    await expect(service().disconnect(inactive.token)).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
  });

  it("rechecks session ownership in repository and cannot touch another administrator", async () => {
    const first = await fixture.admin();
    const second = await fixture.admin();
    const secondConnection = await fixture.adminConnection(second.id);
    const repository = new AdminTelegramRepository(database, LINK_CONFIGURATION);

    await expect(
      repository.readAdmin({ adminUserId: second.id, sessionToken: first.token }),
    ).resolves.toEqual({ kind: "UNAUTHORIZED" });
    await expect(
      repository.disconnectAdmin({ adminUserId: second.id, sessionToken: first.token }),
    ).resolves.toEqual({ kind: "UNAUTHORIZED" });
    await expect(
      database.adminTelegramConnection.findUniqueOrThrow({ where: { id: secondConnection.id } }),
    ).resolves.toMatchObject({ disabledAt: null, disabledReason: null });

    await database.adminSession.update({
      where: { id: first.sessionId },
      data: { revokedAt: new Date() },
    });
    const staleServiceIdentity = new AdminTelegramService(database, repository, {
      readActiveAdmin: async () => ({ id: first.id, login: first.login }),
    });
    await expect(staleServiceIdentity.getState(first.token)).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
    await expect(staleServiceIdentity.disconnect(first.token)).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
  });

  it("disconnects atomically, revokes unused links and invalidates only its jobs", async () => {
    const admin = await fixture.admin();
    const other = await fixture.admin();
    await createLinkService(database).issueAdminLink(admin.token);
    const connection = await fixture.adminConnection(admin.id);
    const otherConnection = await fixture.adminConnection(other.id);
    const pending = await job({ connectionId: connection.id });
    const processing = await job({ connectionId: connection.id, status: "PROCESSING" });
    const sent = await job({ connectionId: connection.id, status: "SENT" });
    const otherJob = await job({ connectionId: otherConnection.id });

    await expect(service().disconnect(admin.token)).resolves.toEqual({
      ok: true,
      alreadyDisconnected: false,
    });
    const disabled = await database.adminTelegramConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(disabled.disabledAt).toBeInstanceOf(Date);
    expect(disabled.disabledReason).toBe("USER_DISCONNECTED");
    expect(
      await database.telegramLinkToken.count({
        where: { adminUserId: admin.id, usedAt: null, revokedAt: null },
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
      database.notificationOutbox.findUniqueOrThrow({ where: { id: otherJob.id } }),
    ).resolves.toMatchObject({ status: "PENDING", invalidationCode: null });
    await expect(
      database.adminTelegramConnection.findUniqueOrThrow({ where: { id: otherConnection.id } }),
    ).resolves.toMatchObject({ disabledAt: null });

    await expect(service().disconnect(admin.token)).resolves.toEqual({
      ok: true,
      alreadyDisconnected: true,
    });
    const repeated = await database.adminTelegramConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(repeated.disabledAt).toEqual(disabled.disabledAt);
    expect(repeated.disabledReason).toBe("USER_DISCONNECTED");
  });

  it("rolls back connection and token changes if outbox invalidation fails", async () => {
    const admin = await fixture.admin();
    await createLinkService(database).issueAdminLink(admin.token);
    const connection = await fixture.adminConnection(admin.id);
    const broken = service(database, {
      invalidateOutbox: async () => {
        throw new Error("INVALIDATION_FAULT_CANARY");
      },
    });
    const error = await broken.disconnect(admin.token).catch((value: unknown) => value);
    expect(JSON.stringify(error)).not.toContain("CANARY");
    await expect(
      database.adminTelegramConnection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).resolves.toMatchObject({ disabledAt: null, disabledReason: null });
    expect(
      await database.telegramLinkToken.count({
        where: { adminUserId: admin.id, usedAt: null, revokedAt: null },
      }),
    ).toBe(1);
  });

  it("serializes Start against revoke and disconnect without partial state", async () => {
    for (const operation of ["REVOKE", "DISCONNECT"] as const) {
      await fixture.cleanupRows();
      await fixture.readyBot();
      const admin = await fixture.admin();
      const links = createLinkService(database);
      const issued = raw(await links.issueAdminLink(admin.token));
      const [startResult] = await bounded(
        Promise.all([
          start(concurrentDatabase, issued),
          operation === "REVOKE"
            ? links.revokeAdminLink(admin.token)
            : service().disconnect(admin.token),
        ]),
        8_000,
      );
      expect(["CONNECTED", "REJECTED"]).toContain(startResult.kind);
      const active = await database.adminTelegramConnection.findMany({
        where: { adminUserId: admin.id, disabledAt: null },
      });
      expect(active).toHaveLength(
        operation === "REVOKE" && startResult.kind === "CONNECTED" ? 1 : 0,
      );
      expect(
        await database.telegramLinkToken.count({
          where: { adminUserId: admin.id, usedAt: null, revokedAt: null },
        }),
      ).toBe(0);
      if (operation === "DISCONNECT") {
        const connectionJobs = await database.notificationOutbox.findMany({
          where: { adminConnection: { adminUserId: admin.id } },
        });
        expect(connectionJobs.every((row) => row.invalidationCode === "CONNECTION_DISABLED")).toBe(
          true,
        );
      }
    }
  });

  it("reconnects with a new immutable connection and never retargets old jobs", async () => {
    const admin = await fixture.admin();
    const links = createLinkService(database);
    const firstLink = raw(await links.issueAdminLink(admin.token));
    expect((await start(database, firstLink)).kind).toBe("CONNECTED");
    const firstConnection = await database.adminTelegramConnection.findFirstOrThrow({
      where: { adminUserId: admin.id, disabledAt: null },
    });
    await service().disconnect(admin.token);
    const oldJobs = await database.notificationOutbox.findMany({
      where: { adminConnectionId: firstConnection.id },
      select: { id: true },
    });

    const secondLink = raw(await links.issueAdminLink(admin.token));
    expect((await start(database, secondLink)).kind).toBe("CONNECTED");
    const connections = await database.adminTelegramConnection.findMany({
      where: { adminUserId: admin.id },
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
        adminConnectionId: firstConnection.id,
        invalidationCode: "CONNECTION_DISABLED",
      });
    }
  });
});
