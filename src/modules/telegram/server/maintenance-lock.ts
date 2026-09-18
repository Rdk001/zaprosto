import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export type TelegramMaintenanceAdvisoryLockKey = Readonly<{
  namespace: number;
  key: number;
}>;

// Dedicated namespace member. 61 is polling leadership; delivery uses bigint keys.
export const TELEGRAM_MAINTENANCE_ADVISORY_LOCK_KEY = {
  namespace: 526_008,
  key: 66,
} as const satisfies TelegramMaintenanceAdvisoryLockKey;

export type TelegramMaintenanceLockMode = "WORKER_SHARED" | "OPERATOR_EXCLUSIVE";

export class TelegramMaintenanceLockError extends Error {
  constructor(readonly code: "MAINTENANCE_LOCK_FAILED" | "MAINTENANCE_LOCK_LOST") {
    super(code);
    this.name = "TelegramMaintenanceLockError";
  }

  toJSON() {
    return { name: this.name, code: this.code } as const;
  }
}

export interface TelegramMaintenanceLockSession {
  readonly mode: TelegramMaintenanceLockMode;
  readonly signal: AbortSignal;
  release(): Promise<void>;
}

export interface TelegramMaintenanceLockSource {
  acquireWorker(): Promise<TelegramMaintenanceLockSession>;
  tryAcquireOperator(): Promise<TelegramMaintenanceLockSession | null>;
}

type MaintenanceClient = Pick<PoolClient, "on" | "removeListener" | "release"> & {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
};

type MaintenancePool = Pick<Pool, "connect"> & {
  connect(): Promise<MaintenanceClient>;
};

type BooleanRow = { value: boolean };

function checkedKey(key: TelegramMaintenanceAdvisoryLockKey) {
  if (
    !Number.isSafeInteger(key.namespace) ||
    !Number.isSafeInteger(key.key) ||
    key.namespace < 0 ||
    key.key < 0 ||
    key.namespace > 2_147_483_647 ||
    key.key > 2_147_483_647
  ) {
    throw new TelegramMaintenanceLockError("MAINTENANCE_LOCK_FAILED");
  }
  return key;
}

class PostgresTelegramMaintenanceSession implements TelegramMaintenanceLockSession {
  private readonly controller = new AbortController();
  private valid = true;
  private releasePromise: Promise<void> | undefined;

  readonly signal = this.controller.signal;

  constructor(
    private readonly client: MaintenanceClient,
    private readonly lockKey: TelegramMaintenanceAdvisoryLockKey,
    readonly mode: TelegramMaintenanceLockMode,
  ) {
    client.on("error", this.onConnectionLost);
    client.on("end", this.onConnectionLost);
  }

  private readonly onConnectionLost = () => {
    if (!this.valid) return;
    this.valid = false;
    this.controller.abort(new TelegramMaintenanceLockError("MAINTENANCE_LOCK_LOST"));
  };

  release(): Promise<void> {
    this.releasePromise ??= this.releaseOnce();
    return this.releasePromise;
  }

  private async releaseOnce(): Promise<void> {
    const wasValid = this.valid;
    this.valid = false;
    this.controller.abort();
    let destroy = !wasValid;
    let failed = false;

    if (wasValid) {
      try {
        const sql =
          this.mode === "WORKER_SHARED"
            ? "SELECT pg_advisory_unlock_shared($1::integer, $2::integer) AS value"
            : "SELECT pg_advisory_unlock($1::integer, $2::integer) AS value";
        const result = await this.client.query<BooleanRow>(sql, [
          this.lockKey.namespace,
          this.lockKey.key,
        ]);
        destroy = result.rows.length !== 1 || result.rows[0]?.value !== true;
        failed = destroy;
      } catch {
        destroy = true;
        failed = true;
      }
    }

    this.client.removeListener("error", this.onConnectionLost);
    this.client.removeListener("end", this.onConnectionLost);
    try {
      this.client.release(destroy || undefined);
    } catch {
      throw new TelegramMaintenanceLockError("MAINTENANCE_LOCK_FAILED");
    }
    if (failed) throw new TelegramMaintenanceLockError("MAINTENANCE_LOCK_FAILED");
  }
}

export class PostgresTelegramMaintenanceLockSource implements TelegramMaintenanceLockSource {
  private readonly lockKey: TelegramMaintenanceAdvisoryLockKey;

  constructor(
    private readonly pool: MaintenancePool,
    lockKey: TelegramMaintenanceAdvisoryLockKey = TELEGRAM_MAINTENANCE_ADVISORY_LOCK_KEY,
  ) {
    this.lockKey = checkedKey(lockKey);
  }

  acquireWorker(): Promise<TelegramMaintenanceLockSession> {
    return this.acquire("WORKER_SHARED").then((session) => {
      if (!session) throw new TelegramMaintenanceLockError("MAINTENANCE_LOCK_FAILED");
      return session;
    });
  }

  tryAcquireOperator(): Promise<TelegramMaintenanceLockSession | null> {
    return this.acquire("OPERATOR_EXCLUSIVE");
  }

  private async acquire(
    mode: TelegramMaintenanceLockMode,
  ): Promise<TelegramMaintenanceLockSession | null> {
    let client: MaintenanceClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new TelegramMaintenanceLockError("MAINTENANCE_LOCK_FAILED");
    }

    let handedOff = false;
    let connectionLost = false;
    const onConnectionLost = () => {
      connectionLost = true;
    };
    client.on("error", onConnectionLost);
    client.on("end", onConnectionLost);

    try {
      const sql =
        mode === "WORKER_SHARED"
          ? "SELECT true AS value FROM pg_advisory_lock_shared($1::integer, $2::integer)"
          : "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS value";
      const result = await client.query<BooleanRow>(sql, [
        this.lockKey.namespace,
        this.lockKey.key,
      ]);
      if (connectionLost) throw new TelegramMaintenanceLockError("MAINTENANCE_LOCK_FAILED");
      const acquired = result.rows.length === 1 && result.rows[0]?.value === true;
      if (!acquired) return null;

      client.removeListener("error", onConnectionLost);
      client.removeListener("end", onConnectionLost);
      handedOff = true;
      return new PostgresTelegramMaintenanceSession(client, this.lockKey, mode);
    } catch (error) {
      connectionLost = true;
      if (error instanceof TelegramMaintenanceLockError) throw error;
      throw new TelegramMaintenanceLockError("MAINTENANCE_LOCK_FAILED");
    } finally {
      if (!handedOff) {
        client.removeListener("error", onConnectionLost);
        client.removeListener("end", onConnectionLost);
        try {
          client.release(connectionLost || undefined);
        } catch {
          throw new TelegramMaintenanceLockError("MAINTENANCE_LOCK_FAILED");
        }
      }
    }
  }
}
