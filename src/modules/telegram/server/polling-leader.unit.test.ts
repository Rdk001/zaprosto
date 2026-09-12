import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  PostgresTelegramPollingLeaderSource,
  TELEGRAM_POLLING_ADVISORY_LOCK_KEY,
} from "./polling-leader";

class FakeClient extends EventEmitter {
  readonly release = vi.fn();
  readonly query = vi.fn();
}

describe("Telegram polling PostgreSQL leader session", () => {
  it("keeps the production lock key fixed", () => {
    expect(TELEGRAM_POLLING_ADVISORY_LOCK_KEY).toEqual({ namespace: 526_008, key: 61 });
  });

  it("returns null and releases the connection when another session owns the lock", async () => {
    const client = new FakeClient();
    client.query.mockResolvedValueOnce({ rows: [{ value: false }] });
    const source = new PostgresTelegramPollingLeaderSource({
      connect: vi.fn(async () => client),
    } as never);

    await expect(source.tryAcquire()).resolves.toBeNull();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each(["error", "end"] as const)(
    "invalidates leadership and aborts active work on connection %s",
    async (event) => {
      const client = new FakeClient();
      client.query.mockResolvedValueOnce({ rows: [{ value: true }] });
      const source = new PostgresTelegramPollingLeaderSource({
        connect: vi.fn(async () => client),
      } as never);
      const session = await source.tryAcquire();
      expect(session).not.toBeNull();

      if (event === "error") client.emit(event, new Error("secret driver cause"));
      else client.emit(event);

      expect(session?.signal.aborted).toBe(true);
      await expect(session?.confirmLeadership()).resolves.toBe(false);
      await session?.close();
      expect(client.release).toHaveBeenCalledWith(true);
    },
  );

  it("re-checks pg_locks without re-entering pg_try_advisory_lock", async () => {
    const client = new FakeClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ value: true }] })
      .mockResolvedValueOnce({ rows: [{ value: true }] })
      .mockResolvedValueOnce({ rows: [{ value: true }] });
    const source = new PostgresTelegramPollingLeaderSource({
      connect: vi.fn(async () => client),
    } as never);
    const session = await source.tryAcquire();

    await expect(session?.confirmLeadership()).resolves.toBe(true);
    expect(client.query.mock.calls[1]?.[0]).toContain("FROM pg_locks");
    expect(client.query.mock.calls[1]?.[0]).not.toContain("pg_try_advisory_lock");
    await session?.close();
    expect(client.query.mock.calls[2]?.[0]).toContain("pg_advisory_unlock");
  });

  it("closes idempotently and unlocks a healthy session exactly once", async () => {
    const client = new FakeClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ value: true }] })
      .mockResolvedValueOnce({ rows: [{ value: true }] });
    const session = await new PostgresTelegramPollingLeaderSource({
      connect: vi.fn(async () => client),
    } as never).tryAcquire();

    await Promise.all([session?.close(), session?.close()]);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
