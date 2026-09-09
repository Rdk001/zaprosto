import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelegramBotApi } from "../../src/modules/telegram/server/bot-api";
import { createTelegramBotApi } from "../../src/modules/telegram/server/bot-api";
import { TelegramBotStateRepository } from "../../src/modules/telegram/server/bot-state-repository";
import { FakeTelegramTransport } from "../../src/modules/telegram/server/fake-transport";
import { verifyTelegramBotReadiness } from "../../src/modules/telegram/server/readiness-service";
import type { TelegramRuntimeConfiguration } from "../../src/modules/telegram/server/runtime-config";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";
import {
  beforeCommitClient,
  createOutboxFixture,
  isolatedOutboxDatabaseUrl,
} from "./telegram-outbox-fixture";

const database = createPrismaClient(isolatedOutboxDatabaseUrl());
const tokenCanary = "123456:TELEGRAM_BOT_TOKEN_CANARY_06_3A";
const configuration: TelegramRuntimeConfiguration = {
  kind: "ENABLED",
  botToken: tokenCanary,
  botUsername: "Zaprosto_Test_Bot",
  pollTimeoutSeconds: 30,
};
const verifiedAt = new Date("2032-02-01T08:00:00.000Z");
const oldVerifiedAt = new Date("2032-02-01T07:00:00.000Z");
const lastPollAt = new Date("2032-02-01T07:59:00.000Z");
let fixture: Awaited<ReturnType<typeof createOutboxFixture>>;
const fetchSpy = vi.fn(() => {
  throw new Error("Network is forbidden in TelegramBotState tests");
});

function fakeApi(input: { id?: bigint; username?: string; webhook?: boolean } = {}) {
  return {
    getMe: vi.fn(async () => ({
      id: input.id ?? 5_000_000_001n,
      username: input.username ?? "zaprosto_test_bot",
    })),
    getWebhookInfo: vi.fn(async () => ({
      hasWebhook: input.webhook ?? false,
      hasCustomCertificate: false,
      pendingUpdateCount: 0,
    })),
    deleteWebhook: vi.fn(async () => undefined),
    getUpdates: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ messageId: 1n })),
  } satisfies TelegramBotApi;
}

async function resetBotState() {
  await database.telegramBotState.update({
    where: { id: 1 },
    data: {
      botUserId: null,
      botUsername: null,
      nextUpdateId: 0n,
      lastVerifiedAt: null,
      lastPollAt: null,
      lastErrorCode: null,
    },
  });
}

beforeAll(async () => {
  fixture = await createOutboxFixture(database);
});
beforeEach(async () => {
  vi.stubGlobal("fetch", fetchSpy);
  await resetBotState();
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await resetBotState();
  await fixture?.cleanup();
  await database.$disconnect();
});

describe("TelegramBotState PostgreSQL readiness transitions", () => {
  it("records the first verified identity in the singleton", async () => {
    const repository = new TelegramBotStateRepository(database);
    await expect(
      verifyTelegramBotReadiness({
        configuration,
        api: fakeApi(),
        state: repository,
        clock: () => verifiedAt,
      }),
    ).resolves.toMatchObject({ status: "VERIFIED", verified: true });

    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      botUserId: 5_000_000_001n,
      botUsername: "zaprosto_test_bot",
      nextUpdateId: 0n,
      lastVerifiedAt: verifiedAt,
      lastPollAt: null,
      lastErrorCode: null,
    });
  });

  it("preserves offset, polling heartbeat, username, and connections for case-only differences", async () => {
    await database.telegramBotState.update({
      where: { id: 1 },
      data: {
        botUserId: 5_000_000_001n,
        botUsername: "zaprosto_test_bot",
        nextUpdateId: 9_000_000_123n,
        lastVerifiedAt: oldVerifiedAt,
        lastPollAt,
        lastErrorCode: "NETWORK_UNREACHABLE",
      },
    });
    const connectionsBefore = await Promise.all([
      database.appointmentTelegramConnection.count(),
      database.adminTelegramConnection.count(),
    ]);

    await verifyTelegramBotReadiness({
      configuration,
      api: fakeApi({ username: "ZAPROSTO_TEST_BOT" }),
      state: new TelegramBotStateRepository(database),
      clock: () => verifiedAt,
    });

    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      botUserId: 5_000_000_001n,
      botUsername: "zaprosto_test_bot",
      nextUpdateId: 9_000_000_123n,
      lastVerifiedAt: verifiedAt,
      lastPollAt,
      lastErrorCode: null,
    });
    await expect(
      Promise.all([
        database.appointmentTelegramConnection.count(),
        database.adminTelegramConnection.count(),
      ]),
    ).resolves.toEqual(connectionsBefore);
  });

  it("fails closed for a changed username on the same bot id", async () => {
    await database.telegramBotState.update({
      where: { id: 1 },
      data: {
        botUserId: 5_000_000_001n,
        botUsername: "old_username",
        nextUpdateId: 9_000_000_123n,
        lastVerifiedAt: oldVerifiedAt,
        lastPollAt,
        lastErrorCode: "NETWORK_UNREACHABLE",
      },
    });
    const connectionsBefore = await Promise.all([
      database.appointmentTelegramConnection.count(),
      database.adminTelegramConnection.count(),
    ]);
    await expect(
      new TelegramBotStateRepository(database).recordVerifiedIdentity({
        botUserId: 5_000_000_001n,
        botUsername: "ZAPROSTO_TEST_BOT",
        verifiedAt,
      }),
    ).resolves.toBe("BOT_IDENTITY_MISMATCH");

    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      botUserId: 5_000_000_001n,
      botUsername: "old_username",
      nextUpdateId: 9_000_000_123n,
      lastVerifiedAt: oldVerifiedAt,
      lastPollAt,
      lastErrorCode: "BOT_IDENTITY_MISMATCH",
    });
    await expect(
      Promise.all([
        database.appointmentTelegramConnection.count(),
        database.adminTelegramConnection.count(),
      ]),
    ).resolves.toEqual(connectionsBefore);
  });

  it("fails closed and keeps the previous identity for a different bot id", async () => {
    await database.telegramBotState.update({
      where: { id: 1 },
      data: {
        botUserId: 5_000_000_099n,
        botUsername: "zaprosto_test_bot",
        nextUpdateId: 777n,
        lastVerifiedAt: oldVerifiedAt,
        lastPollAt,
      },
    });
    const api = fakeApi({ id: 5_000_000_001n });
    await expect(
      verifyTelegramBotReadiness({
        configuration,
        api,
        state: new TelegramBotStateRepository(database),
        clock: () => verifiedAt,
      }),
    ).resolves.toMatchObject({
      status: "NOT_READY",
      reasonCode: "BOT_IDENTITY_MISMATCH",
    });
    expect(api.getWebhookInfo).not.toHaveBeenCalled();

    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      botUserId: 5_000_000_099n,
      botUsername: "zaprosto_test_bot",
      nextUpdateId: 777n,
      lastVerifiedAt: oldVerifiedAt,
      lastPollAt,
      lastErrorCode: "BOT_IDENTITY_MISMATCH",
    });
  });

  it("records WEBHOOK_ACTIVE without storing or returning the webhook URL", async () => {
    const webhookCanary = "https://example.invalid/WEBHOOK_URL_CANARY_06_3A";
    const api = createTelegramBotApi(
      new FakeTelegramTransport([
        {
          kind: "RESPONSE",
          body: {
            ok: true,
            result: { id: 5_000_000_001, is_bot: true, username: "zaprosto_test_bot" },
          },
        },
        {
          kind: "RESPONSE",
          body: {
            ok: true,
            result: {
              url: webhookCanary,
              has_custom_certificate: false,
              pending_update_count: 0,
            },
          },
        },
      ]),
    );
    const result = await verifyTelegramBotReadiness({
      configuration,
      api,
      state: new TelegramBotStateRepository(database),
      clock: () => verifiedAt,
    });
    const state = await database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } });
    const serialized = JSON.stringify({ result, state }, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );

    expect(result).toMatchObject({ reasonCode: "WEBHOOK_ACTIVE" });
    expect(state).toMatchObject({
      botUserId: null,
      botUsername: null,
      lastVerifiedAt: null,
      lastErrorCode: "WEBHOOK_ACTIVE",
    });
    expect(serialized).not.toContain(webhookCanary);
    expect(serialized).not.toContain(tokenCanary);
  });

  it("clears a safe global error after successful recovery", async () => {
    await database.telegramBotState.update({
      where: { id: 1 },
      data: {
        botUserId: 5_000_000_001n,
        botUsername: "zaprosto_test_bot",
        lastVerifiedAt: oldVerifiedAt,
        lastPollAt,
        lastErrorCode: "CONFIG_UNAUTHORIZED",
      },
    });

    await verifyTelegramBotReadiness({
      configuration,
      api: fakeApi(),
      state: new TelegramBotStateRepository(database),
      clock: () => verifiedAt,
    });
    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      botUserId: 5_000_000_001n,
      lastVerifiedAt: verifiedAt,
      lastPollAt,
      lastErrorCode: null,
    });
  });

  it("rolls back identity changes when an artificial pre-commit failure occurs", async () => {
    const rollbackCanary = "ARTIFICIAL_BOT_STATE_ROLLBACK_CANARY";
    const failingDatabase = beforeCommitClient(database, async () => {
      throw new Error(rollbackCanary);
    });
    const result = await verifyTelegramBotReadiness({
      configuration,
      api: fakeApi(),
      state: new TelegramBotStateRepository(failingDatabase),
      clock: () => verifiedAt,
    });

    expect(result).toEqual({
      status: "NOT_READY",
      verified: false,
      reasonCode: "BOT_STATE_STORAGE_FAILURE",
      botUsername: "Zaprosto_Test_Bot",
    });
    await expect(
      database.telegramBotState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      botUserId: null,
      botUsername: null,
      nextUpdateId: 0n,
      lastVerifiedAt: null,
      lastPollAt: null,
      lastErrorCode: null,
    });
    expect(JSON.stringify(result)).not.toContain(rollbackCanary);
  });
});
