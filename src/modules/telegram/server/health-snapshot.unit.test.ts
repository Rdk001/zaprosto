import { describe, expect, it } from "vitest";

import { buildTelegramHealthSnapshot, type TelegramHealthConfiguration } from "./health-snapshot";

const NOW = new Date("2036-01-02T03:04:05.000Z");

function raw(
  overrides: Partial<Parameters<typeof buildTelegramHealthSnapshot>[1]> = {},
): Parameters<typeof buildTelegramHealthSnapshot>[1] {
  return {
    statePresent: true,
    now: NOW,
    botUserId: 42n,
    botUsername: "zaprosto_test_bot",
    lastVerifiedAt: NOW,
    lastPollAt: NOW,
    lastErrorCode: null,
    statusCounts: [],
    oldestDueAt: null,
    expiredLeases: 0n,
    skippedClientReminders: 0n,
    newestDeadAt: null,
    sentJobs: 0n,
    additionalAttemptClaims: 0n,
    jobsWithLastRateLimitCode: 0n,
    latencySampleSize: 0n,
    averageConfirmedSendLatencyMs: null,
    maximumConfirmedSendLatencyMs: null,
    ...overrides,
  };
}

const enabled: TelegramHealthConfiguration = {
  kind: "ENABLED",
  botUsername: "zaprosto_test_bot",
};

describe("Telegram health snapshot DTO", () => {
  it("keeps the exact two-minute polling boundary healthy and marks only the next millisecond stale", () => {
    const exact = buildTelegramHealthSnapshot(
      enabled,
      raw({
        lastVerifiedAt: new Date(NOW.getTime() - 120_000),
        lastPollAt: new Date(NOW.getTime() - 120_000),
      }),
    );
    expect(exact.status).toBe("HEALTHY");
    expect(exact.readiness.polling).toMatchObject({
      status: "READY",
      lastPollAgeMs: 120_000,
    });

    const stale = buildTelegramHealthSnapshot(
      enabled,
      raw({ lastPollAt: new Date(NOW.getTime() - 120_001) }),
    );
    expect(stale.status).toBe("DEGRADED");
    expect(stale.readiness.polling).toMatchObject({
      status: "STALE",
      reasonCode: "POLLING_STALE",
      lastPollAgeMs: 120_001,
    });
  });

  it("keeps the exact five-minute due boundary healthy and degrades on the next millisecond", () => {
    const exact = buildTelegramHealthSnapshot(
      enabled,
      raw({ oldestDueAt: new Date(NOW.getTime() - 300_000) }),
    );
    expect(exact.queue).toMatchObject({ oldestDueAgeMs: 300_000, dueQueueStale: false });
    expect(exact.status).toBe("HEALTHY");

    const stale = buildTelegramHealthSnapshot(
      enabled,
      raw({ oldestDueAt: new Date(NOW.getTime() - 300_001) }),
    );
    expect(stale.queue).toMatchObject({ oldestDueAgeMs: 300_001, dueQueueStale: true });
    expect(stale.status).toBe("DEGRADED");
  });

  it("returns fixed zero groups and typed disabled, incomplete, invalid and uninitialized states", () => {
    for (const [configuration, expected] of [
      [{ kind: "DISABLED" } as const, "DISABLED"],
      [{ kind: "INCOMPLETE", reasonCode: "BOT_TOKEN_REQUIRED" } as const, "NOT_READY"],
      [{ kind: "INVALID", reasonCode: "BOT_USERNAME_INVALID" } as const, "NOT_READY"],
    ] as const) {
      const snapshot = buildTelegramHealthSnapshot(configuration, raw());
      expect(snapshot.status).toBe("NOT_READY");
      expect(snapshot.readiness.polling.status).toBe(expected);
      expect(Object.keys(snapshot.queue.byNotificationType)).toHaveLength(8);
      expect(snapshot.queue.byNotificationType.CLIENT_APPOINTMENT_CHANGED).toEqual({
        pending: 0,
        processing: 0,
        dead: 0,
      });
    }

    const uninitialized = buildTelegramHealthSnapshot(
      enabled,
      raw({ botUserId: null, botUsername: null, lastVerifiedAt: null, lastPollAt: null }),
    );
    expect(uninitialized.status).toBe("NOT_READY");
    expect(uninitialized.readiness.polling.reasonCode).toBe("IDENTITY_UNVERIFIED");
    expect(uninitialized.readiness.delivery.reasonCode).toBe("IDENTITY_UNVERIFIED");
  });

  it("exposes only bounded aggregates and does not make historical DEAD permanently unhealthy", () => {
    const snapshot = buildTelegramHealthSnapshot(
      enabled,
      raw({
        statusCounts: [
          { type: "ADMIN_APPOINTMENT_CREATED", pending: "2", processing: "3", dead: "4" },
        ],
        expiredLeases: 1n,
        skippedClientReminders: 5n,
        newestDeadAt: new Date(NOW.getTime() - 60_000),
        sentJobs: 6n,
        additionalAttemptClaims: 7n,
        jobsWithLastRateLimitCode: 8n,
        latencySampleSize: 6n,
        averageConfirmedSendLatencyMs: 1_250n,
        maximumConfirmedSendLatencyMs: 9_000n,
      }),
    );
    expect(snapshot.status).toBe("DEGRADED");
    expect(snapshot.queue.byNotificationType.ADMIN_APPOINTMENT_CREATED).toEqual({
      pending: 2,
      processing: 3,
      dead: 4,
    });
    expect(snapshot.deliveryMetrics).toEqual({
      sentJobs: 6,
      additionalAttemptClaims: 7,
      jobsWithLastRateLimitCode: 8,
      confirmedSendLatencyMs: { sampleSize: 6, average: 1_250, maximum: 9_000 },
    });
    expect(snapshot.queue.newestDeadAt).toBe("2036-01-02T03:03:05.000Z");
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);

    const historicalDeadOnly = buildTelegramHealthSnapshot(
      enabled,
      raw({ newestDeadAt: new Date(NOW.getTime() - 60_000) }),
    );
    expect(historicalDeadOnly.status).toBe("HEALTHY");
  });

  it("fails closed for future timestamps, unsafe counts and unsafe global codes", () => {
    const future = buildTelegramHealthSnapshot(
      enabled,
      raw({ lastPollAt: new Date(NOW.getTime() + 1) }),
    );
    expect(future.readiness.polling).toMatchObject({
      status: "NOT_READY",
      reasonCode: "POLLING_TIMESTAMP_INVALID",
      lastPollAgeMs: null,
    });

    expect(() =>
      buildTelegramHealthSnapshot(enabled, raw({ sentJobs: BigInt(Number.MAX_SAFE_INTEGER) + 1n })),
    ).toThrowError("TELEGRAM_HEALTH_STORAGE_FAILURE");
    expect(() =>
      buildTelegramHealthSnapshot(enabled, raw({ lastErrorCode: "raw sql secret" })),
    ).toThrowError("TELEGRAM_HEALTH_STORAGE_FAILURE");
  });
});
