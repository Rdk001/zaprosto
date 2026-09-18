import { describe, expect, it, vi } from "vitest";

import type { TelegramCleanupResult } from "./cleanup-repository";
import {
  TELEGRAM_CLEANUP_DEFAULT_BATCH_SIZE,
  TELEGRAM_CLEANUP_DEFAULT_INTERVAL_MS,
  TelegramCleanupSupervisor,
} from "./cleanup-supervisor";

const emptyResult: TelegramCleanupResult = {
  deletedDirectRejectedOutbox: 0,
  deletedOtherOutbox: 0,
  deletedLinkTokens: 0,
  deletedDisabledAppointmentConnections: 0,
  deletedDisabledAdminConnections: 0,
  deletedRetiredAppointmentConnections: 0,
};

describe("TelegramCleanupSupervisor", () => {
  it("uses bounded production defaults and stops an interval wait through AbortSignal", async () => {
    const cleanup = { run: vi.fn(async () => emptyResult) };
    const observed: { milliseconds?: number; signal?: AbortSignal } = {};
    const supervisor = new TelegramCleanupSupervisor(
      { cleanup, logger: { log: vi.fn() } },
      {
        sleep: vi.fn(async (milliseconds, signal) => {
          observed.milliseconds = milliseconds;
          observed.signal = signal;
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }),
      },
    );

    const running = supervisor.run();
    await vi.waitFor(() => expect(cleanup.run).toHaveBeenCalledOnce());
    await supervisor.stop();
    await running;

    expect(cleanup.run).toHaveBeenCalledWith({ batchSize: TELEGRAM_CLEANUP_DEFAULT_BATCH_SIZE });
    expect(observed.milliseconds).toBe(TELEGRAM_CLEANUP_DEFAULT_INTERVAL_MS);
    expect(observed.signal?.aborted).toBe(true);
  });

  it("isolates storage failures, logs only the bounded code and continues after the interval", async () => {
    const secret = "chatId=123 token=secret raw SQL";
    const cleanup = {
      run: vi
        .fn<() => Promise<TelegramCleanupResult>>()
        .mockRejectedValueOnce(new Error(secret))
        .mockResolvedValue(emptyResult),
    };
    const log = vi.fn();
    const sleep = vi.fn(async () => {
      if (cleanup.run.mock.calls.length >= 2) {
        void Promise.resolve().then(() => supervisor.stop());
      }
    });
    const supervisor = new TelegramCleanupSupervisor(
      { cleanup, logger: { log } },
      { intervalMs: 1, batchSize: 7, sleep },
    );

    await supervisor.run();

    expect(cleanup.run).toHaveBeenCalledTimes(2);
    expect(cleanup.run).toHaveBeenNthCalledWith(1, { batchSize: 7 });
    expect(log).toHaveBeenCalledExactlyOnceWith("TELEGRAM_CLEANUP_FAILED");
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });

  it("rejects unsafe scheduling values", () => {
    const dependencies = { cleanup: { run: vi.fn() }, logger: { log: vi.fn() } };
    expect(() => new TelegramCleanupSupervisor(dependencies, { intervalMs: 0 })).toThrow(
      "TELEGRAM_CLEANUP_CONFIGURATION_INVALID",
    );
    expect(() => new TelegramCleanupSupervisor(dependencies, { batchSize: 0 })).toThrow(
      "TELEGRAM_CLEANUP_CONFIGURATION_INVALID",
    );
    expect(() => new TelegramCleanupSupervisor(dependencies, { batchSize: 501 })).toThrow(
      "TELEGRAM_CLEANUP_CONFIGURATION_INVALID",
    );
  });
});
