import { describe, expect, it, vi } from "vitest";

import {
  runTelegramWebhookTransitionCommand,
  TELEGRAM_WEBHOOK_TRANSITION_CONFIRMATION,
} from "./webhook-transition-command";
import type { TelegramWebhookTransitionResult } from "./webhook-transition-service";

const environment = {
  TELEGRAM_BOT_TOKEN: "123456:COMMAND_TOKEN_CANARY_123456789",
  TELEGRAM_BOT_USERNAME: "Transition_Test_Bot",
};

function setup(overrides: Record<string, unknown> = {}) {
  const write = vi.fn();
  const release = vi.fn(async () => undefined);
  const controller = new AbortController();
  const service = {
    transition: vi.fn<(input: { signal: AbortSignal }) => Promise<TelegramWebhookTransitionResult>>(
      async () => ({ status: "TRANSITIONED" }),
    ),
  };
  const input = {
    argv: [],
    stdinIsTTY: true,
    stdoutIsTTY: true,
    environment,
    readConfirmation: vi.fn(async () => TELEGRAM_WEBHOOK_TRANSITION_CONFIRMATION),
    write,
    createApi: vi.fn(() => ({
      getMe: vi.fn(),
      getWebhookInfo: vi.fn(),
      deleteWebhook: vi.fn(),
    })),
    createService: vi.fn(() => service),
    maintenance: {
      tryAcquireOperator: vi.fn(async () => ({
        mode: "OPERATOR_EXCLUSIVE" as const,
        signal: controller.signal,
        release,
      })),
    },
    ...overrides,
  };
  return { input, service, write, release, controller };
}

describe("Telegram webhook transition operator command", () => {
  it.each([
    [{ stdinIsTTY: false }, "TTY_REQUIRED"],
    [{ stdoutIsTTY: false }, "TTY_REQUIRED"],
    [{ argv: ["--token=SECRET"] }, "ARGUMENTS_FORBIDDEN"],
  ] as const)("rejects argv, pipe, or non-TTY input", async (override, code) => {
    const { input, service } = setup(override);
    await expect(runTelegramWebhookTransitionCommand(input)).rejects.toMatchObject({ code });
    expect(input.readConfirmation).not.toHaveBeenCalled();
    expect(input.maintenance.tryAcquireOperator).not.toHaveBeenCalled();
    expect(service.transition).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "CONFIG_DISABLED"],
    [{ TELEGRAM_BOT_TOKEN: environment.TELEGRAM_BOT_TOKEN }, "CONFIG_INCOMPLETE"],
    [{ ...environment, TELEGRAM_BOT_TOKEN: "invalid-secret" }, "CONFIG_INVALID"],
  ] as const)("rejects disabled, incomplete, and invalid configuration", async (env, code) => {
    const { input } = setup({ environment: env });
    await expect(runTelegramWebhookTransitionCommand(input)).rejects.toMatchObject({ code });
    expect(input.maintenance.tryAcquireOperator).not.toHaveBeenCalled();
    expect(input.createApi).not.toHaveBeenCalled();
  });

  it("requires exact confirmation before lock or API creation", async () => {
    const { input, service } = setup({ readConfirmation: vi.fn(async () => "delete") });
    await expect(runTelegramWebhookTransitionCommand(input)).rejects.toMatchObject({
      code: "CONFIRMATION_MISMATCH",
    });
    expect(input.maintenance.tryAcquireOperator).not.toHaveBeenCalled();
    expect(input.createApi).not.toHaveBeenCalled();
    expect(service.transition).not.toHaveBeenCalled();
  });

  it("returns WORKER_ACTIVE before fake API creation", async () => {
    const { input, service } = setup({
      maintenance: { tryAcquireOperator: vi.fn(async () => null) },
    });
    await expect(runTelegramWebhookTransitionCommand(input)).rejects.toMatchObject({
      code: "WORKER_ACTIVE",
    });
    expect(input.createApi).not.toHaveBeenCalled();
    expect(service.transition).not.toHaveBeenCalled();
  });

  it.each(["TRANSITIONED", "NO_CHANGE"] as const)(
    "prints only a bounded %s result and releases exactly once",
    async (status) => {
      const { input, service, write, release } = setup();
      service.transition.mockResolvedValueOnce({ status });
      await expect(runTelegramWebhookTransitionCommand(input)).resolves.toEqual({ status });
      expect(release).toHaveBeenCalledOnce();
      const serialized = JSON.stringify({ output: write.mock.calls, status });
      expect(serialized).not.toContain(environment.TELEGRAM_BOT_TOKEN);
      expect(serialized).not.toContain(environment.TELEGRAM_BOT_USERNAME);
      expect(serialized).not.toContain("https://");
      expect(serialized).not.toContain("raw response");
    },
  );

  it("passes the maintenance session signal and releases once on error", async () => {
    const { input, service, release, controller } = setup();
    service.transition.mockRejectedValueOnce(new Error("RAW_URL_CANARY"));
    await expect(runTelegramWebhookTransitionCommand(input)).rejects.toThrow();
    expect(service.transition).toHaveBeenCalledWith({ signal: controller.signal });
    expect(release).toHaveBeenCalledOnce();
  });
});
