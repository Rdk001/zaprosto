import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  PostgresTelegramMaintenanceLockSource,
  TELEGRAM_MAINTENANCE_ADVISORY_LOCK_KEY,
  TelegramMaintenanceLockError,
} from "./maintenance-lock";

class FakeClient extends EventEmitter {
  readonly release = vi.fn();
  readonly query = vi.fn();
}

describe("Telegram maintenance PostgreSQL session lock", () => {
  it("uses a dedicated documented key and shared worker lock", async () => {
    expect(TELEGRAM_MAINTENANCE_ADVISORY_LOCK_KEY).toEqual({ namespace: 526_008, key: 66 });
    const client = new FakeClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ value: true }] })
      .mockResolvedValueOnce({ rows: [{ value: true }] });
    const session = await new PostgresTelegramMaintenanceLockSource({
      connect: vi.fn(async () => client),
    } as never).acquireWorker();

    expect(client.query.mock.calls[0]?.[0]).toContain("pg_advisory_lock_shared");
    expect(session.mode).toBe("WORKER_SHARED");
    await session.release();
    expect(client.query.mock.calls[1]?.[0]).toContain("pg_advisory_unlock_shared");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("fails fast with null when a shared worker blocks the exclusive operator lock", async () => {
    const client = new FakeClient();
    client.query.mockResolvedValueOnce({ rows: [{ value: false }] });
    const source = new PostgresTelegramMaintenanceLockSource({
      connect: vi.fn(async () => client),
    } as never);

    await expect(source.tryAcquireOperator()).resolves.toBeNull();
    expect(client.query.mock.calls[0]?.[0]).toContain("pg_try_advisory_lock");
    expect(client.query.mock.calls[0]?.[0]).not.toContain("shared");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each(["error", "end"] as const)(
    "aborts and destroys a worker session after connection %s",
    async (event) => {
      const client = new FakeClient();
      client.query.mockResolvedValueOnce({ rows: [{ value: true }] });
      const session = await new PostgresTelegramMaintenanceLockSource({
        connect: vi.fn(async () => client),
      } as never).acquireWorker();

      if (event === "error") client.emit(event, new Error("secret driver cause"));
      else client.emit(event);
      expect(session.signal.aborted).toBe(true);
      await session.release();
      expect(client.release).toHaveBeenCalledWith(true);
      expect(JSON.stringify(session.signal.reason)).not.toContain("secret driver cause");
    },
  );

  it("releases an exclusive session exactly once and checks unlock", async () => {
    const client = new FakeClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ value: true }] })
      .mockResolvedValueOnce({ rows: [{ value: true }] });
    const session = await new PostgresTelegramMaintenanceLockSource({
      connect: vi.fn(async () => client),
    } as never).tryAcquireOperator();

    await Promise.all([session?.release(), session?.release()]);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1]?.[0]).toContain("pg_advisory_unlock");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("destroys a session and exposes only a safe error when unlock fails", async () => {
    const client = new FakeClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ value: true }] })
      .mockRejectedValueOnce(new Error("password=secret raw SQL"));
    const session = await new PostgresTelegramMaintenanceLockSource({
      connect: vi.fn(async () => client),
    } as never).tryAcquireOperator();

    await expect(session?.release()).rejects.toEqual(
      new TelegramMaintenanceLockError("MAINTENANCE_LOCK_FAILED"),
    );
    expect(client.release).toHaveBeenCalledWith(true);
    expect(JSON.stringify(await session?.release().catch((error) => error))).not.toContain(
      "password=secret",
    );
  });

  it("destroys the connection and hides the driver cause when acquire fails", async () => {
    const client = new FakeClient();
    client.query.mockRejectedValueOnce(new Error("postgresql://secret raw query"));
    const source = new PostgresTelegramMaintenanceLockSource({
      connect: vi.fn(async () => client),
    } as never);

    const error = await source.tryAcquireOperator().catch((caught) => caught);
    expect(error).toMatchObject({ code: "MAINTENANCE_LOCK_FAILED" });
    expect(JSON.stringify(error)).not.toContain("postgresql://secret");
    expect(client.release).toHaveBeenCalledWith(true);
  });
});
