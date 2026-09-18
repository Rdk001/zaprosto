import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createTelegramWorkerRuntime,
  runTelegramWorkerProcess,
  TELEGRAM_WORKER_DELIVERY_CONCURRENCY,
  TELEGRAM_WORKER_POOL_MAX,
  TelegramWorkerRuntime,
  type TelegramWorkerDiagnosticCode,
  type TelegramWorkerRootLoop,
} from "./worker-runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rootLoop(order: string[], name: string): TelegramWorkerRootLoop {
  const running = deferred<void>();
  return {
    run: vi.fn(async () => {
      order.push(`${name}:run`);
      return running.promise;
    }),
    stop: vi.fn(async () => {
      order.push(`${name}:stop`);
      running.resolve();
    }),
  };
}

function setup() {
  const order: string[] = [];
  const polling = rootLoop(order, "polling");
  const delivery = rootLoop(order, "delivery");
  const dataCleanup = rootLoop(order, "cleanup");
  const pool = { end: vi.fn(async () => order.push("pool:end")) };
  const database = { $disconnect: vi.fn(async () => order.push("database:disconnect")) };
  const unregister = vi.fn(() => order.push("pool:unregister"));
  const controller = new AbortController();
  const maintenanceSession = {
    mode: "WORKER_SHARED" as const,
    signal: controller.signal,
    release: vi.fn(async () => {
      order.push("maintenance:release");
    }),
  };
  const maintenance = { acquireWorker: vi.fn(async () => maintenanceSession) };
  const runtime = new TelegramWorkerRuntime({
    polling,
    delivery,
    dataCleanup,
    maintenance,
    pool: pool as never,
    database: database as never,
    unregisterPoolErrorHandler: unregister,
  });
  return {
    runtime,
    polling,
    delivery,
    dataCleanup,
    maintenance,
    maintenanceSession,
    controller,
    pool,
    database,
    unregister,
    order,
  };
}

describe("TelegramWorkerRuntime", () => {
  it("starts polling, delivery and cleanup together and cleans resources after stop", async () => {
    const {
      runtime,
      polling,
      delivery,
      dataCleanup,
      maintenance,
      maintenanceSession,
      pool,
      database,
      unregister,
      order,
    } = setup();
    const running = runtime.run();
    await vi.waitFor(() => {
      expect(polling.run).toHaveBeenCalledOnce();
      expect(delivery.run).toHaveBeenCalledOnce();
      expect(dataCleanup.run).toHaveBeenCalledOnce();
      expect(maintenance.acquireWorker).toHaveBeenCalledOnce();
    });

    await Promise.all([runtime.stop(), runtime.stop(), running]);
    expect(polling.stop).toHaveBeenCalledOnce();
    expect(delivery.stop).toHaveBeenCalledOnce();
    expect(dataCleanup.stop).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(database.$disconnect).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(maintenanceSession.release).toHaveBeenCalledOnce();
    expect(order.indexOf("maintenance:release")).toBeGreaterThan(order.indexOf("delivery:stop"));
    expect(order.indexOf("pool:end")).toBeGreaterThan(order.indexOf("maintenance:release"));
    expect(order.indexOf("pool:end")).toBeGreaterThan(order.indexOf("polling:stop"));
    expect(order.indexOf("database:disconnect")).toBeGreaterThan(order.indexOf("delivery:stop"));
  });

  it("turns an unexpected root-loop exit into coordinated shutdown", async () => {
    const { runtime, polling, delivery, dataCleanup, pool, database } = setup();
    const pollingRun = polling.run as ReturnType<typeof vi.fn>;
    pollingRun.mockResolvedValueOnce(undefined);

    await expect(runtime.run()).rejects.toMatchObject({ code: "WORKER_ROOT_LOOP_EXITED" });
    expect(delivery.stop).toHaveBeenCalledOnce();
    expect(dataCleanup.stop).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(database.$disconnect).toHaveBeenCalledOnce();
  });

  it("handles repeated signals without duplicated cleanup and removes handlers", async () => {
    const { runtime, pool, database } = setup();
    const processEmitter = new EventEmitter() as EventEmitter & {
      exitCode?: string | number | null;
    };
    const logged: TelegramWorkerDiagnosticCode[] = [];
    const processRun = runTelegramWorkerProcess({
      runtime,
      process: processEmitter,
      logger: { log: (code) => logged.push(code) },
    });
    await vi.waitFor(() => expect(processEmitter.listenerCount("SIGINT")).toBe(1));

    processEmitter.emit("SIGINT");
    processEmitter.emit("SIGINT");
    processEmitter.emit("SIGTERM");
    await processRun;

    expect(pool.end).toHaveBeenCalledOnce();
    expect(database.$disconnect).toHaveBeenCalledOnce();
    expect(processEmitter.listenerCount("SIGINT")).toBe(0);
    expect(processEmitter.listenerCount("SIGTERM")).toBe(0);
    expect(logged).toEqual(["WORKER_STARTED", "WORKER_STOPPED"]);
  });

  it("uses a pool slot for polling plus bounded delivery concurrency", () => {
    expect(TELEGRAM_WORKER_DELIVERY_CONCURRENCY).toBe(4);
    expect(TELEGRAM_WORKER_POOL_MAX).toBe(TELEGRAM_WORKER_DELIVERY_CONCURRENCY + 2);
  });

  it("builds and stops the disabled production graph before run", async () => {
    const runtime = createTelegramWorkerRuntime({
      databaseUrl: "postgresql://unused:unused@127.0.0.1:1/unused",
      environment: {},
      logger: { log: vi.fn() },
    });
    await runtime.stop();
  });

  it("does not start either root loop until the shared maintenance lock is held", async () => {
    const { polling, delivery, dataCleanup, maintenanceSession } = setup();
    const acquired = deferred<typeof maintenanceSession>();
    const acquireWorker = vi.fn(() => acquired.promise);
    const waiting = new TelegramWorkerRuntime({
      polling,
      delivery,
      dataCleanup,
      maintenance: { acquireWorker },
      pool: { end: vi.fn(async () => undefined) } as never,
      database: { $disconnect: vi.fn(async () => undefined) } as never,
      unregisterPoolErrorHandler: vi.fn(),
    });

    const running = waiting.run();
    await vi.waitFor(() => expect(acquireWorker).toHaveBeenCalledOnce());
    expect(polling.run).not.toHaveBeenCalled();
    expect(delivery.run).not.toHaveBeenCalled();
    expect(dataCleanup.run).not.toHaveBeenCalled();
    acquired.resolve(maintenanceSession);
    await vi.waitFor(() => expect(polling.run).toHaveBeenCalledOnce());
    expect(dataCleanup.run).toHaveBeenCalledOnce();
    await waiting.stop();
    await running;
  });

  it("turns maintenance session loss into coordinated root shutdown", async () => {
    const { runtime, polling, delivery, dataCleanup, controller, maintenanceSession } = setup();
    const running = runtime.run();
    await vi.waitFor(() => expect(delivery.run).toHaveBeenCalledOnce());

    controller.abort(new Error("secret driver cause"));
    await expect(running).rejects.toMatchObject({ code: "WORKER_MAINTENANCE_GUARD_LOST" });
    expect(polling.stop).toHaveBeenCalledOnce();
    expect(delivery.stop).toHaveBeenCalledOnce();
    expect(dataCleanup.stop).toHaveBeenCalledOnce();
    expect(maintenanceSession.release).toHaveBeenCalledOnce();
  });

  it("reports fatal with safe codes only when a root loop exits unexpectedly", async () => {
    const secret = "DATABASE_URL=secret BOT_TOKEN raw Error payload chatId";
    const order: string[] = [];
    const polling = rootLoop(order, "polling");
    (polling.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(secret));
    const runtime = new TelegramWorkerRuntime({
      polling,
      delivery: rootLoop(order, "delivery"),
      dataCleanup: rootLoop(order, "cleanup"),
      maintenance: {
        acquireWorker: vi.fn(async () => ({
          mode: "WORKER_SHARED" as const,
          signal: new AbortController().signal,
          release: vi.fn(async () => undefined),
        })),
      },
      pool: { end: vi.fn(async () => undefined) } as never,
      database: { $disconnect: vi.fn(async () => undefined) } as never,
      unregisterPoolErrorHandler: vi.fn(),
    });
    const processEmitter = new EventEmitter() as EventEmitter & {
      exitCode?: string | number | null;
    };
    const logged: TelegramWorkerDiagnosticCode[] = [];

    await runTelegramWorkerProcess({
      runtime,
      process: processEmitter,
      logger: { log: (code) => logged.push(code) },
    });

    expect(processEmitter.exitCode).toBe(1);
    expect(logged).toEqual(["WORKER_STARTED", "WORKER_FATAL", "WORKER_STOPPED"]);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });
});
