import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  TelegramDeliveryRateGate,
  TelegramDeliveryRateGateError,
  type TelegramDeliveryRateGateLockSpace,
} from "./delivery-rate-gate";

const testLockSpace: TelegramDeliveryRateGateLockSpace = {
  globalKey: 8_000_000_001n,
  chatKey: (chatId) => -(8_000_000_000n + chatId),
};

class FakeClient extends EventEmitter {
  readonly release = vi.fn();
  readonly query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    void sql;
    void values;
    return { rows: [{ value: true }] };
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function setup(client = new FakeClient()) {
  let now = 0;
  const sleeps: number[] = [];
  const connect = vi.fn(async () => client);
  const gate = new TelegramDeliveryRateGate({ connect } as never, {
    lockSpace: testLockSpace,
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });
  return {
    client,
    connect,
    gate,
    sleeps,
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

function queryKey(client: FakeClient, call: number) {
  return client.query.mock.calls[call]?.[1]?.[0];
}

describe("TelegramDeliveryRateGate", () => {
  it("acquires chat before global, starts once after both, and returns the exact result", async () => {
    const client = new FakeClient();
    const global = deferred<{ rows: { value: boolean }[] }>();
    client.query
      .mockResolvedValueOnce({ rows: [{ value: true }] })
      .mockImplementationOnce(() => global.promise)
      .mockResolvedValue({ rows: [{ value: true }] });
    const { gate } = setup(client);
    const resultValue = { identity: "same" };
    const callback = vi.fn(async () => resultValue);
    const running = gate.run({ chatId: 7n }, callback);

    await vi.waitFor(() => expect(client.query).toHaveBeenCalledTimes(2));
    expect(queryKey(client, 0)).toBe(testLockSpace.chatKey(7n).toString());
    expect(queryKey(client, 1)).toBe(testLockSpace.globalKey.toString());
    expect(callback).not.toHaveBeenCalled();

    global.resolve({ rows: [{ value: true }] });
    const result = await running;
    expect(callback).toHaveBeenCalledOnce();
    expect(result).toBe(resultValue);
  });

  it("holds global for 40ms and chat for 1000ms from callback start", async () => {
    const { gate, client, sleeps, now } = setup();
    await gate.run({ chatId: 11n }, async () => "ok");

    expect(sleeps).toEqual([40, 960]);
    expect(now()).toBe(1_000);
    expect(queryKey(client, 2)).toBe(testLockSpace.globalKey.toString());
    expect(queryKey(client, 3)).toBe(testLockSpace.chatKey(11n).toString());
  });

  it("releases global while a long callback is still active", async () => {
    const operation = deferred<string>();
    const { gate, client } = setup();
    const running = gate.run({ chatId: 12n }, () => operation.promise);

    await vi.waitFor(() => expect(client.query).toHaveBeenCalledTimes(3));
    expect(queryKey(client, 2)).toBe(testLockSpace.globalKey.toString());
    operation.resolve("done");
    await expect(running).resolves.toBe("done");
  });

  it("keeps chat locked until callback completion without a second delay after slow HTTP", async () => {
    const operation = deferred<void>();
    const state = setup();
    const running = state.gate.run({ chatId: 13n }, () => operation.promise);
    await vi.waitFor(() => expect(state.client.query).toHaveBeenCalledTimes(3));
    state.advance(1_100);
    expect(state.client.query).toHaveBeenCalledTimes(3);
    operation.resolve();
    await running;
    expect(state.sleeps).toEqual([40]);
    expect(queryKey(state.client, 3)).toBe(testLockSpace.chatKey(13n).toString());
  });

  it("rethrows the original callback error once after cleanup", async () => {
    const expected = new Error("original callback error");
    const callback = vi.fn(async () => {
      throw expected;
    });
    const { gate, client } = setup();

    await expect(gate.run({ chatId: 14n }, callback)).rejects.toBe(expected);
    expect(callback).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("does not start callback when chat acquisition fails", async () => {
    const client = new FakeClient();
    client.query.mockRejectedValueOnce(new Error("secret database cause"));
    const callback = vi.fn();
    const { gate } = setup(client);

    await expect(gate.run({ chatId: 15n }, callback)).rejects.toMatchObject({
      code: "RATE_GATE_ACQUIRE_FAILED",
      message: "RATE_GATE_ACQUIRE_FAILED",
    });
    expect(callback).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("destroys the session when global acquisition fails after chat lock", async () => {
    const client = new FakeClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ value: true }] })
      .mockRejectedValueOnce(new Error("secret database cause"));
    const callback = vi.fn();
    const { gate } = setup(client);

    await expect(gate.run({ chatId: 16n }, callback)).rejects.toBeInstanceOf(
      TelegramDeliveryRateGateError,
    );
    expect(callback).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("destroys on false global unlock but preserves a confirmed callback result", async () => {
    const client = new FakeClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ value: true }] })
      .mockResolvedValueOnce({ rows: [{ value: true }] })
      .mockResolvedValueOnce({ rows: [{ value: false }] });
    const { gate } = setup(client);

    await expect(gate.run({ chatId: 17n }, async () => "confirmed")).resolves.toBe("confirmed");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it.each(["error", "end"] as const)(
    "aborts callback and destroys exactly once on session %s",
    async (event) => {
      const { gate, client } = setup();
      const callback = vi.fn(
        (signal: AbortSignal) =>
          new Promise<string>((resolve) => {
            signal.addEventListener("abort", () => resolve("stopped"), { once: true });
          }),
      );
      const running = gate.run({ chatId: 18n }, callback);
      await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());

      if (event === "error") client.emit(event, new Error("secret session cause"));
      else client.emit(event);

      await expect(running).resolves.toBe("stopped");
      expect(callback.mock.calls[0]?.[0].aborted).toBe(true);
      expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    },
  );

  it("rejects an already aborted caller without taking a connection", async () => {
    const controller = new AbortController();
    controller.abort();
    const { gate, connect } = setup();
    const callback = vi.fn();

    await expect(
      gate.run({ chatId: 19n, signal: controller.signal }, callback),
    ).rejects.toMatchObject({ code: "RATE_GATE_ABORTED" });
    expect(connect).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it("destroys a session and skips callback when caller aborts during lock wait", async () => {
    const controller = new AbortController();
    const waiting = deferred<{ rows: { value: boolean }[] }>();
    const client = new FakeClient();
    client.query.mockImplementationOnce(() => waiting.promise);
    client.release.mockImplementationOnce(() => waiting.reject(new Error("connection closed")));
    const callback = vi.fn();
    const { gate } = setup(client);
    const running = gate.run({ chatId: 20n, signal: controller.signal }, callback);
    await vi.waitFor(() => expect(client.query).toHaveBeenCalledOnce());

    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "RATE_GATE_ABORTED" });
    expect(callback).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("forwards caller abort after start while preserving timed lock cleanup", async () => {
    const controller = new AbortController();
    const { gate, client } = setup();
    const running = gate.run(
      { chatId: 21n, signal: controller.signal },
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("caller-stopped"), { once: true });
        }),
    );
    await vi.waitFor(() => expect(client.query).toHaveBeenCalledTimes(3));

    controller.abort();

    await expect(running).resolves.toBe("caller-stopped");
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
    expect(client.query).toHaveBeenCalledTimes(4);
  });

  it("removes client and caller listeners and returns a healthy session once", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const { gate, client } = setup();

    await gate.run({ chatId: 22n, signal: controller.signal }, async () => undefined);

    expect(client.listenerCount("error")).toBe(0);
    expect(client.listenerCount("end")).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("passes bigint keys to pg as decimal strings without Number conversion", async () => {
    const chatId = 9_007_199_254_740_993n;
    const { gate, client } = setup();
    await gate.run({ chatId }, async () => undefined);

    expect(queryKey(client, 0)).toBe(testLockSpace.chatKey(chatId).toString());
    expect(queryKey(client, 0)).not.toBe(Number(chatId));
  });

  it.each([0n, -1n, 9_223_372_036_854_775_808n, 1, "1"])(
    "rejects invalid chatId %s with a bounded safe error",
    async (chatId) => {
      const { gate, connect } = setup();
      const callback = vi.fn();
      const error = await gate.run({ chatId } as never, callback).catch((value) => value);

      expect(error).toEqual(
        expect.objectContaining({
          name: "TelegramDeliveryRateGateError",
          code: "RATE_GATE_INPUT_INVALID",
          message: "RATE_GATE_INPUT_INVALID",
        }),
      );
      expect((error as TelegramDeliveryRateGateError).toJSON()).toEqual({
        name: "TelegramDeliveryRateGateError",
        code: "RATE_GATE_INPUT_INVALID",
      });
      expect(connect).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
    },
  );
});
