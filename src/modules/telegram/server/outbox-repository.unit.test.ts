import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../../generated/prisma/client";
import { TelegramOutboxRepository, invalidateTelegramOutbox } from "./outbox-repository";

const id = "11111111-1111-4111-8111-111111111111";
const leaseToken = "22222222-2222-4222-8222-222222222222";

describe("Outbox repository boundary without PostgreSQL or Next.js", () => {
  it.each([
    "NETWORK_UNREACHABLE",
    "RESPONSE_INVALID",
    "DELIVERY_OUTCOME_UNKNOWN",
    "BOT_IDENTITY_MISMATCH",
    "WEBHOOK_ACTIVE",
  ])("does not allow %s to obtain configuration compensation", async (errorCode) => {
    const transaction = vi.fn();
    const repository = new TelegramOutboxRepository({
      $transaction: transaction,
    } as unknown as PrismaClient);
    await expect(
      repository.finish({ id, leaseToken, outcome: "CONFIGURATION_FAILURE", errorCode } as never),
    ).rejects.toMatchObject({ code: "OUTBOX_INPUT_INVALID" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(["", " ", "worker", "host.example", "D:/private/path", "x".repeat(101)])(
    "rejects non-opaque or unbounded owner before SQL",
    async (leaseOwner) => {
      const transaction = vi.fn();
      const repository = new TelegramOutboxRepository({
        $transaction: transaction,
      } as unknown as PrismaClient);
      await expect(repository.claimDue({ capacity: 1, leaseOwner })).rejects.toMatchObject({
        code: "OUTBOX_INPUT_INVALID",
      });
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity])(
    "rejects recovery batch %s before SQL",
    async (batchSize) => {
      const transaction = vi.fn();
      const repository = new TelegramOutboxRepository({
        $transaction: transaction,
      } as unknown as PrismaClient);
      await expect(repository.recoverExpired({ batchSize })).rejects.toMatchObject({
        code: "OUTBOX_INPUT_INVALID",
      });
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it("rejects arbitrary filters and fields rather than turning them into SQL", async () => {
    const query = vi.fn();
    const database = { $queryRaw: query } as unknown as PrismaClient;
    for (const target of [
      { kind: "ALL" },
      { kind: "ADMIN_CONNECTION", id, sql: "arbitrary" },
      { kind: "APPOINTMENT", id, types: [] },
      { kind: "APPOINTMENT", id, types: ["UNKNOWN"] },
    ])
      await expect(
        invalidateTelegramOutbox(database, {
          target,
          code: "BOT_REPLACED",
          now: new Date(),
        } as never),
      ).rejects.toMatchObject({ code: "OUTBOX_INPUT_INVALID" });
    expect(query).not.toHaveBeenCalled();
  });

  it("does not rethrow driver messages, nested causes or arbitrary sensitive properties", async () => {
    const canary = "unsafe-driver-canary";
    const database = {
      $transaction: vi.fn().mockRejectedValue(
        Object.assign(new Error(canary), {
          cause: new Error(canary),
          payload: { secret: canary },
          connectionString: canary,
        }),
      ),
    } as unknown as PrismaClient;
    const repository = new TelegramOutboxRepository(database);
    const error = await repository
      .claimDue({ capacity: 1, leaseOwner: id })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ name: "TelegramOutboxError", code: "OUTBOX_STORAGE_FAILURE" });
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("payload");
    expect(String(error)).not.toContain(canary);
    expect(JSON.stringify(error)).toBe(
      '{"name":"TelegramOutboxError","code":"OUTBOX_STORAGE_FAILURE"}',
    );
  });
});
