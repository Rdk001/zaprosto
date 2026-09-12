import { EventEmitter } from "node:events";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { TelegramPollingDiagnosticCode } from "./polling-orchestrator";
import { registerTelegramWorkerPoolErrorHandler } from "./worker-pool";

describe("Telegram worker pool error handler", () => {
  it("handles an idle client error and logs only a safe diagnostic code", () => {
    const emitter = new EventEmitter();
    const secret = "DATABASE_URL=postgres://secret connection password stack";
    const logged: TelegramPollingDiagnosticCode[] = [];
    const unregister = registerTelegramWorkerPoolErrorHandler(
      emitter as unknown as Pick<Pool, "on" | "removeListener">,
      { log: (code) => logged.push(code) },
    );

    expect(() => emitter.emit("error", new Error(secret), {})).not.toThrow();
    expect(logged).toEqual(["LEADER_SESSION_FAILURE"]);
    expect(JSON.stringify(logged)).not.toContain(secret);

    unregister();
  });

  it("does not crash if the safe logger fails and unregisters idempotently", () => {
    const emitter = new EventEmitter();
    const unregister = registerTelegramWorkerPoolErrorHandler(
      emitter as unknown as Pick<Pool, "on" | "removeListener">,
      {
        log: vi.fn(() => {
          throw new Error("logger unavailable");
        }),
      },
    );

    expect(() => emitter.emit("error", new Error("connection details"), {})).not.toThrow();
    expect(emitter.listenerCount("error")).toBe(1);
    unregister();
    unregister();
    expect(emitter.listenerCount("error")).toBe(0);
  });
});
