import pg from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  TelegramDeliveryRateGate,
  type TelegramDeliveryRateGateLockSpace,
} from "../../src/modules/telegram/server/delivery-rate-gate";
import { bounded, isolatedOutboxDatabaseUrl } from "./telegram-outbox-fixture";

const connectionString = isolatedOutboxDatabaseUrl();
const firstPool = new pg.Pool({ connectionString, max: 1 });
const secondPool = new pg.Pool({ connectionString, max: 1 });
const observerPool = new pg.Pool({ connectionString, max: 1 });
const keySeed = BigInt(process.pid % 1_000_000);
const testLockSpace: TelegramDeliveryRateGateLockSpace = {
  globalKey: 7_000_000_000_000n + keySeed,
  chatKey: (chatId) => -(7_100_000_000_000n + keySeed * 10_000n + chatId),
};

function gate(pool: pg.Pool) {
  return new TelegramDeliveryRateGate(pool, { lockSpace: testLockSpace });
}

async function advisoryLockCount() {
  const result = await observerPool.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  `);
  return Number(result.rows[0]?.count ?? "-1");
}

afterEach(async () => {
  await expect(bounded(advisoryLockCount(), 2_000)).resolves.toBe(0);
});

afterAll(async () => {
  await Promise.all([firstPool.end(), secondPool.end(), observerPool.end()]);
});

describe("Telegram delivery rate gate with PostgreSQL sessions", () => {
  it("separates starts for one chat by at least one second across PoolClients", async () => {
    const starts: number[] = [];
    await Promise.all([
      gate(firstPool).run({ chatId: 101n }, async () => {
        starts.push(performance.now());
      }),
      gate(secondPool).run({ chatId: 101n }, async () => {
        starts.push(performance.now());
      }),
    ]);

    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(950);
  });

  it("separates different chats globally while allowing long callbacks to overlap", async () => {
    const starts: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const operation = async () => {
      starts.push(performance.now());
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 150));
      active -= 1;
    };

    await Promise.all([
      gate(firstPool).run({ chatId: 201n }, operation),
      gate(secondPool).run({ chatId: 202n }, operation),
    ]);

    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(30);
    expect(maximumActive).toBe(2);
  });

  it("releases locks after callback error so the next instance continues", async () => {
    const expected = new Error("callback failure");
    await expect(
      gate(firstPool).run({ chatId: 301n }, async () => {
        throw expected;
      }),
    ).rejects.toBe(expected);

    await expect(
      bounded(
        gate(secondPool).run({ chatId: 301n }, async () => "continued"),
        2_500,
      ),
    ).resolves.toBe("continued");
  });

  it("loses locks on backend termination and lets another instance continue", async () => {
    let callbackStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      callbackStarted = resolve;
    });
    const first = gate(firstPool).run({ chatId: 401n }, async (signal) => {
      callbackStarted();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return "session-lost-after-start";
    });
    await started;

    const holders = await observerPool.query<{ pid: number }>(`
      SELECT DISTINCT pid
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND granted
    `);
    expect(holders.rows).toHaveLength(1);
    await observerPool.query("SELECT pg_terminate_backend($1::integer)", [holders.rows[0]!.pid]);

    await expect(bounded(first, 2_000)).resolves.toBe("session-lost-after-start");
    await expect(
      bounded(
        gate(secondPool).run({ chatId: 401n }, async () => "continued"),
        2_500,
      ),
    ).resolves.toBe("continued");
  });
});
