import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const GLOBAL_HOLD_MS = 40;
const CHAT_HOLD_MS = 1_000;

// The one-bigint advisory-lock space is separate from the project's two-integer locks.
// Positive keys are reserved for bot-wide gates; supported positive chat IDs map to
// unique negative keys.
const TELEGRAM_DELIVERY_GLOBAL_LOCK_KEY = 526_008_065n;

type RateGateClient = Pick<PoolClient, "on" | "removeListener" | "release"> & {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
};

type RateGatePool = Pick<Pool, "connect"> & {
  connect(): Promise<RateGateClient>;
};

export type TelegramDeliveryRateGateErrorCode =
  | "RATE_GATE_INPUT_INVALID"
  | "RATE_GATE_ABORTED"
  | "RATE_GATE_ACQUIRE_FAILED"
  | "RATE_GATE_SESSION_LOST";

export type TelegramDeliveryRateGateInput = Readonly<{
  chatId: bigint;
  signal?: AbortSignal;
}>;

export type TelegramDeliveryRateGateLockSpace = Readonly<{
  globalKey: bigint;
  chatKey(chatId: bigint): bigint;
}>;

export type TelegramDeliveryRateGateDependencies = Readonly<{
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  lockSpace?: TelegramDeliveryRateGateLockSpace;
}>;

type BooleanRow = { value: boolean };

export class TelegramDeliveryRateGateError extends Error {
  constructor(readonly code: TelegramDeliveryRateGateErrorCode) {
    super(code);
    this.name = "TelegramDeliveryRateGateError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

const productionLockSpace: TelegramDeliveryRateGateLockSpace = {
  globalKey: TELEGRAM_DELIVERY_GLOBAL_LOCK_KEY,
  chatKey: (chatId) => -chatId,
};

function fail(code: TelegramDeliveryRateGateErrorCode): never {
  throw new TelegramDeliveryRateGateError(code);
}

function validPostgresBigint(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= -MAX_POSTGRES_BIGINT && value <= MAX_POSTGRES_BIGINT;
}

function checkedInput(input: TelegramDeliveryRateGateInput): TelegramDeliveryRateGateInput {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    typeof input.chatId !== "bigint" ||
    input.chatId <= 0n ||
    input.chatId > MAX_POSTGRES_BIGINT ||
    (input.signal !== undefined && !(input.signal instanceof AbortSignal))
  ) {
    fail("RATE_GATE_INPUT_INVALID");
  }
  return input;
}

function checkedLockSpace(
  lockSpace: TelegramDeliveryRateGateLockSpace,
  chatId: bigint,
): Readonly<{ chatKey: bigint; globalKey: bigint }> {
  let chatKey: unknown;
  try {
    chatKey = lockSpace.chatKey(chatId);
  } catch {
    fail("RATE_GATE_INPUT_INVALID");
  }
  const globalKey = lockSpace.globalKey;
  if (
    !validPostgresBigint(chatKey) ||
    !validPostgresBigint(globalKey) ||
    chatKey >= 0n ||
    globalKey <= 0n ||
    chatKey === globalKey
  ) {
    fail("RATE_GATE_INPUT_INVALID");
  }
  return { chatKey, globalKey };
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class TelegramDeliveryRateGate {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly lockSpace: TelegramDeliveryRateGateLockSpace;

  constructor(
    private readonly pool: RateGatePool,
    dependencies: TelegramDeliveryRateGateDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => performance.now());
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.lockSpace = dependencies.lockSpace ?? productionLockSpace;
  }

  async run<T>(
    rawInput: TelegramDeliveryRateGateInput,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const input = checkedInput(rawInput);
    if (typeof operation !== "function") fail("RATE_GATE_INPUT_INVALID");
    const keys = checkedLockSpace(this.lockSpace, input.chatId);
    if (input.signal?.aborted) fail("RATE_GATE_ABORTED");

    let client: RateGateClient;
    try {
      client = await this.pool.connect();
    } catch {
      if (input.signal?.aborted) fail("RATE_GATE_ABORTED");
      fail("RATE_GATE_ACQUIRE_FAILED");
    }

    const internalController = new AbortController();
    const operationController = new AbortController();
    let sessionLost = false;
    let released = false;
    let healthy = true;
    let operationStarted = false;

    const unlinkOperationSignal = () => {
      input.signal?.removeEventListener("abort", abortFromCaller);
      internalController.signal.removeEventListener("abort", abortFromInternal);
    };
    const destroy = () => {
      if (released) return;
      released = true;
      healthy = false;
      client.removeListener("error", onSessionLost);
      client.removeListener("end", onSessionLost);
      client.release(true);
    };
    const abortFromCaller = () => {
      operationController.abort();
      if (!operationStarted) destroy();
    };
    const abortFromInternal = () => operationController.abort();
    const onSessionLost = () => {
      sessionLost = true;
      internalController.abort();
      destroy();
    };

    client.on("error", onSessionLost);
    client.on("end", onSessionLost);
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    internalController.signal.addEventListener("abort", abortFromInternal, { once: true });

    const acquire = async (key: bigint) => {
      const result = await client.query("SELECT pg_advisory_lock($1::bigint)", [key.toString()]);
      if (result.rows.length !== 1) {
        throw new Error("RATE_GATE_LOCK_RESULT_INVALID");
      }
    };

    const invalidate = () => {
      internalController.abort();
      destroy();
    };

    const unlock = async (key: bigint): Promise<boolean> => {
      if (!healthy || released) return false;
      try {
        const result = await client.query<BooleanRow>(
          "SELECT pg_advisory_unlock($1::bigint) AS value",
          [key.toString()],
        );
        if (result.rows.length !== 1 || result.rows[0]?.value !== true) {
          invalidate();
          return false;
        }
        return true;
      } catch {
        invalidate();
        return false;
      }
    };

    const waitUntil = async (deadline: number) => {
      const remaining = Math.max(0, deadline - this.now());
      if (remaining > 0 && healthy) await this.sleep(remaining, internalController.signal);
    };

    try {
      try {
        if (input.signal?.aborted) fail("RATE_GATE_ABORTED");
        await acquire(keys.chatKey);
        if (input.signal?.aborted) fail("RATE_GATE_ABORTED");
        if (sessionLost) fail("RATE_GATE_SESSION_LOST");
        await acquire(keys.globalKey);
        if (input.signal?.aborted) fail("RATE_GATE_ABORTED");
        if (sessionLost) fail("RATE_GATE_SESSION_LOST");
      } catch (error) {
        destroy();
        if (error instanceof TelegramDeliveryRateGateError) throw error;
        if (input.signal?.aborted) fail("RATE_GATE_ABORTED");
        if (sessionLost) fail("RATE_GATE_SESSION_LOST");
        fail("RATE_GATE_ACQUIRE_FAILED");
      }

      const startedAt = this.now();
      operationStarted = true;
      let operationResult: { ok: true; value: T } | { ok: false; error: unknown };
      let operationPromise: Promise<T>;
      try {
        operationPromise = Promise.resolve(operation(operationController.signal));
      } catch (error) {
        operationPromise = Promise.reject(error);
      }
      const globalRelease = (async () => {
        await waitUntil(startedAt + GLOBAL_HOLD_MS);
        await unlock(keys.globalKey);
      })();

      try {
        operationResult = { ok: true, value: await operationPromise };
      } catch (error) {
        operationResult = { ok: false, error };
      }

      await globalRelease;
      await waitUntil(startedAt + CHAT_HOLD_MS);
      await unlock(keys.chatKey);

      if (healthy && !released) {
        released = true;
        client.removeListener("error", onSessionLost);
        client.removeListener("end", onSessionLost);
        client.release();
      }

      if (!operationResult.ok) throw operationResult.error;
      return operationResult.value;
    } finally {
      unlinkOperationSignal();
      client.removeListener("error", onSessionLost);
      client.removeListener("end", onSessionLost);
      if (!released) destroy();
    }
  }
}
