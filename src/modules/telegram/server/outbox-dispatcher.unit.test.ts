import { describe, expect, it, vi } from "vitest";

import type { TelegramDeliveryAttemptResult } from "./delivery-attempt";
import type { ClaimedOutboxJob } from "./outbox-contract";
import { TelegramOutboxDispatcher } from "./outbox-dispatcher";

const sent: TelegramDeliveryAttemptResult = {
  kind: "FINISHED",
  finish: { kind: "APPLIED", status: "SENT" },
};

function claimed(index: number): ClaimedOutboxJob {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    type: "ADMIN_CONNECTION_CONFIRMED",
    attempts: 1,
    leaseToken: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    leaseOwner: "20000000-0000-4000-8000-000000000001",
    claimedAt: new Date("2032-01-01T00:00:00.000Z"),
    leaseExpiresAt: new Date("2032-01-01T00:01:00.000Z"),
    expiresAt: null,
    invalidated: false,
    payloadCheck: { ok: true, payloadVersion: 1 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(jobs: ClaimedOutboxJob[] = [], concurrency = 2) {
  const claimDue = vi.fn().mockResolvedValue(jobs);
  const run = vi.fn().mockResolvedValue(sent);
  const dispatcher = new TelegramOutboxDispatcher(
    { outbox: { claimDue }, attempt: { run } },
    { concurrency },
  );
  return { dispatcher, claimDue, run };
}

describe("TelegramOutboxDispatcher", () => {
  it("returns an empty summary without claiming when already aborted", async () => {
    const { dispatcher, claimDue, run } = setup([claimed(1)]);
    const controller = new AbortController();
    controller.abort();

    await expect(dispatcher.dispatchOnce({ signal: controller.signal })).resolves.toMatchObject({
      claimed: 0,
      started: 0,
      completed: 0,
    });
    expect(claimDue).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("claims once with configured capacity and a UUID owner", async () => {
    const { dispatcher, claimDue } = setup([], 3);

    await dispatcher.dispatchOnce();

    expect(claimDue).toHaveBeenCalledOnce();
    expect(claimDue).toHaveBeenCalledWith({
      capacity: 3,
      leaseOwner: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
  });

  it("returns a zero summary for an empty claim", async () => {
    const { dispatcher } = setup();

    const summary = await dispatcher.dispatchOnce();

    expect(summary).toEqual({
      claimed: 0,
      started: 0,
      completed: 0,
      outcomes: {
        preflightLeaseLost: 0,
        pending: 0,
        sent: 0,
        dead: 0,
        cancelled: 0,
        skipped: 0,
        finishLeaseLost: 0,
        terminal: 0,
        transitionNotAllowed: 0,
      },
      errors: { attemptFailed: 0 },
    });
  });

  it("starts every claimed job exactly once and reports only bounded counters", async () => {
    const jobs = [claimed(1), claimed(2)];
    const { dispatcher, run } = setup(jobs);

    const summary = await dispatcher.dispatchOnce();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls).toEqual([
      [{ jobId: jobs[0]!.id, leaseToken: jobs[0]!.leaseToken }],
      [{ jobId: jobs[1]!.id, leaseToken: jobs[1]!.leaseToken }],
    ]);
    expect(summary).toMatchObject({
      claimed: 2,
      started: 2,
      completed: 2,
      outcomes: { sent: 2 },
      errors: { attemptFailed: 0 },
    });
  });

  it("never exceeds configured concurrency", async () => {
    const releases = [
      deferred<TelegramDeliveryAttemptResult>(),
      deferred<TelegramDeliveryAttemptResult>(),
    ];
    let active = 0;
    let maximum = 0;
    let next = 0;
    const { dispatcher, run } = setup([claimed(1), claimed(2)], 2);
    run.mockImplementation(() => {
      const index = next++;
      active += 1;
      maximum = Math.max(maximum, active);
      return releases[index]!.promise.finally(() => {
        active -= 1;
      });
    });

    const pending = dispatcher.dispatchOnce();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(maximum).toBe(2);
    releases[0]!.resolve(sent);
    releases[1]!.resolve(sent);
    await pending;
    expect(maximum).toBeLessThanOrEqual(2);
  });

  it("isolates a per-job error and waits for every started attempt", async () => {
    const neighbor = deferred<TelegramDeliveryAttemptResult>();
    const { dispatcher, run } = setup([claimed(1), claimed(2)]);
    run.mockRejectedValueOnce(new Error("private failure")).mockReturnValueOnce(neighbor.promise);

    let settled = false;
    const pending = dispatcher.dispatchOnce().then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(settled).toBe(false);

    neighbor.resolve(sent);
    await expect(pending).resolves.toMatchObject({
      claimed: 2,
      started: 2,
      completed: 2,
      outcomes: { sent: 1 },
      errors: { attemptFailed: 1 },
    });
  });

  it("passes abort to every claimed attempt and never makes a second claim", async () => {
    const controller = new AbortController();
    const { dispatcher, claimDue, run } = setup([claimed(1), claimed(2)]);
    run.mockImplementation(
      (input) =>
        new Promise<TelegramDeliveryAttemptResult>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(sent), { once: true });
        }),
    );

    const pending = dispatcher.dispatchOnce({ signal: controller.signal });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    controller.abort();
    await pending;

    expect(claimDue).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.every(([input]) => input.signal === controller.signal)).toBe(true);
  });

  it("does not expose job data or raw attempt errors in the summary", async () => {
    const job = claimed(1);
    const { dispatcher, run } = setup([job]);
    run.mockRejectedValue(new Error("raw database and token detail"));

    const serialized = JSON.stringify(await dispatcher.dispatchOnce());

    for (const forbidden of [
      job.leaseToken,
      "payload",
      "chatId",
      "text",
      "raw database and token detail",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.each([
    { concurrency: 0 },
    { concurrency: 1.5 },
    { concurrency: 21 },
    { concurrency: 1, extra: true },
  ])("strictly rejects invalid configuration %#", (configuration) => {
    expect(
      () =>
        new TelegramOutboxDispatcher(
          { outbox: { claimDue: vi.fn() }, attempt: { run: vi.fn() } },
          configuration,
        ),
    ).toThrowError(expect.objectContaining({ code: "DISPATCH_CONFIGURATION_INVALID" }));
  });

  it("strictly validates dispatch input", async () => {
    const { dispatcher, claimDue } = setup();

    await expect(dispatcher.dispatchOnce({ extra: true } as never)).rejects.toMatchObject({
      code: "DISPATCH_INPUT_INVALID",
    });
    expect(claimDue).not.toHaveBeenCalled();
  });

  it("raises a bounded safe error for claim failure", async () => {
    const { dispatcher, claimDue } = setup();
    claimDue.mockRejectedValue(new Error("postgres://secret SQL text"));

    const error = await dispatcher.dispatchOnce().catch((value) => value);

    expect(error).toEqual(
      expect.objectContaining({
        name: "TelegramOutboxDispatcherError",
        code: "DISPATCH_CLAIM_FAILED",
        message: "DISPATCH_CLAIM_FAILED",
      }),
    );
    expect(JSON.stringify(error)).not.toContain("postgres://secret");
  });

  it("reuses one leaseOwner per instance and uses a different owner for another instance", async () => {
    const first = setup();
    const second = setup();

    await first.dispatcher.dispatchOnce();
    await first.dispatcher.dispatchOnce();
    await second.dispatcher.dispatchOnce();

    const firstOwner = first.claimDue.mock.calls[0]![0].leaseOwner;
    expect(first.claimDue.mock.calls[1]![0].leaseOwner).toBe(firstOwner);
    expect(second.claimDue.mock.calls[0]![0].leaseOwner).not.toBe(firstOwner);
  });
});
