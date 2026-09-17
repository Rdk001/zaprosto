import { describe, expect, it, vi } from "vitest";

import { TelegramBotApiError, type TelegramBotApi } from "./bot-api";
import { TelegramDeliveryAttempt } from "./delivery-attempt";
import type { TelegramDeliveryPreflightResult } from "./delivery-preflight";
import type { FinishOutboxInput, OutboxTransitionResult } from "./outbox-contract";

const jobId = "11111111-1111-4111-8111-111111111111";
const leaseToken = "22222222-2222-4222-8222-222222222222";
const applied: OutboxTransitionResult = { kind: "APPLIED", status: "SENT" };

function setup(preflightResult: TelegramDeliveryPreflightResult) {
  const check = vi.fn().mockResolvedValue(preflightResult);
  const sendMessage = vi.fn<Pick<TelegramBotApi, "sendMessage">["sendMessage"]>();
  sendMessage.mockResolvedValue({ messageId: 42n });
  const finish = vi.fn<(input: FinishOutboxInput) => Promise<OutboxTransitionResult>>();
  finish.mockResolvedValue(applied);
  const attempt = new TelegramDeliveryAttempt({
    preflight: { check },
    api: { sendMessage },
    outbox: { finish },
  });
  return { attempt, check, sendMessage, finish };
}

const run = (attempt: TelegramDeliveryAttempt, signal?: AbortSignal) =>
  attempt.run({ jobId, leaseToken, ...(signal === undefined ? {} : { signal }) });

const apiError = (
  code: ConstructorParameters<typeof TelegramBotApiError>[0]["code"],
  retry?: number,
) =>
  new TelegramBotApiError({
    operation: "sendMessage",
    code,
    ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
  });

describe("TelegramDeliveryAttempt", () => {
  it("returns a preflight lease loss without sending or finishing", async () => {
    const { attempt, sendMessage, finish } = setup({ kind: "LEASE_LOST" });

    await expect(run(attempt)).resolves.toEqual({ kind: "PREFLIGHT_LEASE_LOST" });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("finishes a preflight skip without sending", async () => {
    const { attempt, sendMessage, finish } = setup({
      kind: "SKIP",
      code: "CONNECTION_INACTIVE",
    });

    await expect(run(attempt)).resolves.toEqual({ kind: "FINISHED", finish: applied });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith({
      id: jobId,
      leaseToken,
      outcome: "SKIPPED",
      errorCode: "CONNECTION_INACTIVE",
    });
  });

  it("finishes a dead preflight without sending", async () => {
    const { attempt, sendMessage, finish } = setup({
      kind: "DEAD",
      code: "PAYLOAD_VERSION_UNSUPPORTED",
    });

    await expect(run(attempt)).resolves.toEqual({ kind: "FINISHED", finish: applied });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith({
      id: jobId,
      leaseToken,
      outcome: "DEAD",
      errorCode: "PAYLOAD_VERSION_UNSUPPORTED",
    });
  });

  it("sends READY exactly once and marks it sent", async () => {
    const { attempt, sendMessage, finish } = setup({
      kind: "READY",
      chatId: 123n,
      text: "ready",
    });

    await expect(run(attempt)).resolves.toEqual({ kind: "FINISHED", finish: applied });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({ chatId: 123n, text: "ready" }, undefined);
    expect(finish).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith({ id: jobId, leaseToken, outcome: "SENT" });
  });

  it.each([
    "NETWORK_UNREACHABLE",
    "DELIVERY_OUTCOME_UNKNOWN",
    "TELEGRAM_5XX",
    "RESPONSE_INVALID",
    "RESPONSE_TOO_LARGE",
  ] as const)("maps %s to one RETRY finalization", async (code) => {
    const { attempt, sendMessage, finish } = setup({ kind: "READY", chatId: 123n, text: "x" });
    sendMessage.mockRejectedValue(apiError(code));

    await run(attempt);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith({
      id: jobId,
      leaseToken,
      outcome: "RETRY",
      errorCode: code,
    });
  });

  it("preserves Telegram rate-limit retry_after", async () => {
    const { attempt, sendMessage, finish } = setup({ kind: "READY", chatId: 123n, text: "x" });
    sendMessage.mockRejectedValue(apiError("TELEGRAM_RATE_LIMIT", 137));

    await run(attempt);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith({
      id: jobId,
      leaseToken,
      outcome: "RETRY",
      errorCode: "TELEGRAM_RATE_LIMIT",
      retryAfterSeconds: 137,
    });
  });

  it("omits absent rate-limit retry_after", async () => {
    const { attempt, sendMessage, finish } = setup({ kind: "READY", chatId: 123n, text: "x" });
    sendMessage.mockRejectedValue(apiError("TELEGRAM_RATE_LIMIT"));

    await run(attempt);

    expect(finish).toHaveBeenCalledWith({
      id: jobId,
      leaseToken,
      outcome: "RETRY",
      errorCode: "TELEGRAM_RATE_LIMIT",
    });
  });

  it.each([
    "INVALID_REQUEST",
    "CHAT_NOT_FOUND",
    "BOT_BLOCKED",
    "CHAT_WRITE_FORBIDDEN",
    "TELEGRAM_USER_DEACTIVATED",
  ] as const)("maps %s to DEAD", async (code) => {
    const { attempt, sendMessage, finish } = setup({ kind: "READY", chatId: 123n, text: "x" });
    sendMessage.mockRejectedValue(apiError(code));

    await run(attempt);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith({
      id: jobId,
      leaseToken,
      outcome: "DEAD",
      errorCode: code,
    });
  });

  it("maps CONFIG_UNAUTHORIZED to configuration failure", async () => {
    const { attempt, sendMessage, finish } = setup({ kind: "READY", chatId: 123n, text: "x" });
    sendMessage.mockRejectedValue(apiError("CONFIG_UNAUTHORIZED"));

    await run(attempt);

    expect(finish).toHaveBeenCalledWith({
      id: jobId,
      leaseToken,
      outcome: "CONFIGURATION_FAILURE",
      errorCode: "CONFIG_UNAUTHORIZED",
    });
  });

  it("maps an unknown send error without exposing it", async () => {
    const { attempt, sendMessage, finish } = setup({ kind: "READY", chatId: 123n, text: "x" });
    sendMessage.mockRejectedValue(new Error("private transport detail"));

    const result = await run(attempt);

    expect(result).toEqual({ kind: "FINISHED", finish: applied });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
    expect(finish).toHaveBeenCalledWith({
      id: jobId,
      leaseToken,
      outcome: "RETRY",
      errorCode: "DELIVERY_OUTCOME_UNKNOWN",
    });
  });

  it("returns the repository's actual lease-loss result without a second send", async () => {
    const { attempt, sendMessage, finish } = setup({ kind: "READY", chatId: 123n, text: "x" });
    finish.mockResolvedValue({ kind: "LEASE_LOST" });

    await expect(run(attempt)).resolves.toEqual({
      kind: "FINISHED",
      finish: { kind: "LEASE_LOST" },
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  });

  it("raises a finish failure after a successful send without repeating either call", async () => {
    const { attempt, sendMessage, finish } = setup({ kind: "READY", chatId: 123n, text: "x" });
    const storageFailure = new Error("storage unavailable");
    finish.mockRejectedValue(storageFailure);

    await expect(run(attempt)).rejects.toBe(storageFailure);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  });

  it("raises a preflight failure without sending or finishing", async () => {
    const { attempt, check, sendMessage, finish } = setup({ kind: "LEASE_LOST" });
    const storageFailure = new Error("preflight unavailable");
    check.mockRejectedValue(storageFailure);

    await expect(run(attempt)).rejects.toBe(storageFailure);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("passes the caller's AbortSignal to Telegram", async () => {
    const { attempt, sendMessage } = setup({ kind: "READY", chatId: 123n, text: "x" });
    const signal = new AbortController().signal;

    await run(attempt, signal);

    expect(sendMessage).toHaveBeenCalledWith({ chatId: 123n, text: "x" }, { signal });
  });
});
