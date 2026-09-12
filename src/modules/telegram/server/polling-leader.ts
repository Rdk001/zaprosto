import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export type TelegramPollingAdvisoryLockKey = Readonly<{
  namespace: number;
  key: number;
}>;

export const TELEGRAM_POLLING_ADVISORY_LOCK_KEY = {
  namespace: 526_008,
  key: 61,
} as const satisfies TelegramPollingAdvisoryLockKey;

export interface TelegramPollingLeaderSession {
  readonly signal: AbortSignal;
  confirmLeadership(): Promise<boolean>;
  close(): Promise<void>;
}

export interface TelegramPollingLeaderSource {
  tryAcquire(): Promise<TelegramPollingLeaderSession | null>;
}

type LeaderClient = Pick<PoolClient, "on" | "removeListener" | "release"> & {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
};

type LeaderPool = Pick<Pool, "connect"> & {
  connect(): Promise<LeaderClient>;
};

type BooleanRow = { value: boolean };

function checkedKey(key: TelegramPollingAdvisoryLockKey): TelegramPollingAdvisoryLockKey {
  if (
    !Number.isSafeInteger(key.namespace) ||
    !Number.isSafeInteger(key.key) ||
    key.namespace < 0 ||
    key.key < 0 ||
    key.namespace > 2_147_483_647 ||
    key.key > 2_147_483_647
  ) {
    throw new Error("TELEGRAM_POLLING_LOCK_KEY_INVALID");
  }
  return key;
}

class PostgresTelegramPollingLeaderSession implements TelegramPollingLeaderSession {
  private readonly controller = new AbortController();
  private valid = true;
  private closePromise: Promise<void> | undefined;

  readonly signal = this.controller.signal;

  constructor(
    private readonly client: LeaderClient,
    private readonly lockKey: TelegramPollingAdvisoryLockKey,
  ) {
    client.on("error", this.onConnectionLost);
    client.on("end", this.onConnectionLost);
  }

  private readonly onConnectionLost = () => {
    this.invalidate();
  };

  private invalidate() {
    if (!this.valid) return;
    this.valid = false;
    this.controller.abort();
  }

  async confirmLeadership(): Promise<boolean> {
    if (!this.valid) return false;
    try {
      const result = await this.client.query<BooleanRow>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_locks
           WHERE locktype = 'advisory'
             AND pid = pg_backend_pid()
             AND classid = ($1::integer)::oid
             AND objid = ($2::integer)::oid
             AND objsubid = 2
             AND mode = 'ExclusiveLock'
             AND granted
         ) AS value`,
        [this.lockKey.namespace, this.lockKey.key],
      );
      const owned = result.rows.length === 1 && result.rows[0]?.value === true;
      if (!owned || !this.valid) {
        this.invalidate();
        return false;
      }
      return true;
    } catch {
      this.invalidate();
      return false;
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    const wasValid = this.valid;
    this.invalidate();

    let destroyConnection = !wasValid;
    if (wasValid) {
      try {
        const result = await this.client.query<BooleanRow>(
          "SELECT pg_advisory_unlock($1::integer, $2::integer) AS value",
          [this.lockKey.namespace, this.lockKey.key],
        );
        destroyConnection = result.rows.length !== 1 || result.rows[0]?.value !== true;
      } catch {
        destroyConnection = true;
      }
    }
    this.client.removeListener("error", this.onConnectionLost);
    this.client.removeListener("end", this.onConnectionLost);
    this.client.release(destroyConnection || undefined);
  }
}

export class PostgresTelegramPollingLeaderSource implements TelegramPollingLeaderSource {
  private readonly lockKey: TelegramPollingAdvisoryLockKey;

  constructor(
    private readonly pool: LeaderPool,
    lockKey: TelegramPollingAdvisoryLockKey = TELEGRAM_POLLING_ADVISORY_LOCK_KEY,
  ) {
    this.lockKey = checkedKey(lockKey);
  }

  async tryAcquire(): Promise<TelegramPollingLeaderSession | null> {
    const client = await this.pool.connect();
    let handedOff = false;
    let connectionLost = false;
    const onConnectionLost = () => {
      connectionLost = true;
    };
    client.on("error", onConnectionLost);
    client.on("end", onConnectionLost);

    try {
      const result = await client.query<BooleanRow>(
        "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS value",
        [this.lockKey.namespace, this.lockKey.key],
      );
      if (connectionLost) {
        client.release(true);
        handedOff = true;
        return null;
      }
      if (result.rows.length !== 1 || result.rows[0]?.value !== true) return null;

      client.removeListener("error", onConnectionLost);
      client.removeListener("end", onConnectionLost);
      const session = new PostgresTelegramPollingLeaderSession(client, this.lockKey);
      handedOff = true;
      return session;
    } finally {
      if (!handedOff) {
        client.removeListener("error", onConnectionLost);
        client.removeListener("end", onConnectionLost);
        client.release(connectionLost || undefined);
      }
    }
  }
}
