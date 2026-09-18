import { describe, expect, it, vi } from "vitest";

import {
  runTelegramBotReplacementCommand,
  TELEGRAM_REPLACEMENT_CONFIRMATION,
} from "./bot-replacement-command";

const enabledEnvironment = {
  TELEGRAM_BOT_TOKEN: "123456:TELEGRAM_BOT_TOKEN_CANARY_123456789",
  TELEGRAM_BOT_USERNAME: "Replacement_Test_Bot",
};

function setup(overrides: Record<string, unknown> = {}) {
  const write = vi.fn();
  const release = vi.fn(async () => undefined);
  const service = {
    preflight: vi.fn<() => Promise<{ status: "READY" } | { status: "NO_CHANGE" }>>(async () => ({
      status: "READY",
    })),
    replace: vi.fn(async () => ({
      status: "REPLACED" as const,
      appointmentConnectionsDisabled: 2,
      adminConnectionsDisabled: 1,
      linkTokensRevoked: 3,
      jobsCancelled: 4,
    })),
  };
  return {
    input: {
      argv: [],
      stdinIsTTY: true,
      stdoutIsTTY: true,
      environment: enabledEnvironment,
      readConfirmation: vi.fn(async () => TELEGRAM_REPLACEMENT_CONFIRMATION),
      write,
      createApi: vi.fn(() => ({ getMe: vi.fn() })),
      createService: vi.fn(() => service),
      maintenance: {
        tryAcquireOperator: vi.fn(async () => ({
          mode: "OPERATOR_EXCLUSIVE" as const,
          signal: new AbortController().signal,
          release,
        })),
      },
      ...overrides,
    },
    service,
    write,
    release,
  };
}

describe("Telegram bot replacement operator command", () => {
  it.each([
    [{ stdinIsTTY: false }, "TTY_REQUIRED"],
    [{ stdoutIsTTY: false }, "TTY_REQUIRED"],
    [{ argv: ["token-canary"] }, "ARGUMENTS_FORBIDDEN"],
  ] as const)("rejects non-interactive or argv input", async (override, code) => {
    const { input, service } = setup(override);
    await expect(runTelegramBotReplacementCommand(input)).rejects.toMatchObject({ code });
    expect(service.preflight).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "CONFIG_DISABLED"],
    [{ TELEGRAM_BOT_TOKEN: enabledEnvironment.TELEGRAM_BOT_TOKEN }, "CONFIG_INCOMPLETE"],
    [{ ...enabledEnvironment, TELEGRAM_BOT_TOKEN: "secret-invalid" }, "CONFIG_INVALID"],
  ] as const)(
    "fails safely for disabled, incomplete, and invalid configuration",
    async (env, code) => {
      const { input } = setup({ environment: env });
      await expect(runTelegramBotReplacementCommand(input)).rejects.toMatchObject({ code });
    },
  );

  it("requires the exact typed confirmation before acquiring the exclusive lock", async () => {
    const { input, service } = setup({ readConfirmation: vi.fn(async () => "replace") });
    await expect(runTelegramBotReplacementCommand(input)).rejects.toMatchObject({
      code: "CONFIRMATION_MISMATCH",
    });
    expect(input.maintenance.tryAcquireOperator).not.toHaveBeenCalled();
    expect(service.replace).not.toHaveBeenCalled();
  });

  it("returns WORKER_ACTIVE without mutation when exclusive try-lock is unavailable", async () => {
    const { input, service } = setup({
      maintenance: { tryAcquireOperator: vi.fn(async () => null) },
    });
    await expect(runTelegramBotReplacementCommand(input)).rejects.toMatchObject({
      code: "WORKER_ACTIVE",
    });
    expect(service.replace).not.toHaveBeenCalled();
  });

  it("returns NO_CHANGE without confirmation, lock, or mutation", async () => {
    const { input, service } = setup();
    service.preflight.mockResolvedValueOnce({ status: "NO_CHANGE" });
    await expect(runTelegramBotReplacementCommand(input)).resolves.toEqual({
      status: "NO_CHANGE",
    });
    expect(input.readConfirmation).not.toHaveBeenCalled();
    expect(input.maintenance.tryAcquireOperator).not.toHaveBeenCalled();
    expect(service.replace).not.toHaveBeenCalled();
  });

  it("prints and serializes only safe counts/status and always releases the lock", async () => {
    const { input, write, release } = setup();
    const result = await runTelegramBotReplacementCommand(input);
    const serialized = JSON.stringify({ result, output: write.mock.calls });
    expect(result).toMatchObject({ status: "REPLACED", jobsCancelled: 4 });
    expect(release).toHaveBeenCalledOnce();
    expect(serialized).not.toContain(enabledEnvironment.TELEGRAM_BOT_TOKEN);
    expect(serialized).not.toContain("Replacement_Test_Bot");
    expect(serialized).not.toContain("raw Error");
  });

  it("releases the exclusive lock in finally when the transaction service fails", async () => {
    const { input, service, release } = setup();
    service.replace.mockRejectedValueOnce(new Error("raw database canary"));
    await expect(runTelegramBotReplacementCommand(input)).rejects.toThrow();
    expect(release).toHaveBeenCalledOnce();
  });
});
