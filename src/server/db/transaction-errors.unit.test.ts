import { describe, expect, it, vi } from "vitest";

import { Prisma } from "../../generated/prisma/client";
import { isAppointmentOverlap, retryTransaction } from "./transaction-errors";

function knownError(code: string, sqlState = "23P01", constraint = "appointments_no_overlap") {
  return new Prisma.PrismaClientKnownRequestError("Database operation failed", {
    code,
    clientVersion: "7.10.0",
    meta: {
      driverAdapterError: {
        cause: {
          code: sqlState,
          message: `conflicting key value violates exclusion constraint "${constraint}"`,
        },
      },
    },
  });
}

describe("transaction error handling", () => {
  it("matches only the observed adapter error for this exclusion constraint", () => {
    expect(isAppointmentOverlap(knownError("P2039"))).toBe(true);
    for (const error of [
      knownError("P2004"),
      knownError("P2002"),
      knownError("P2039", "23514"),
      knownError("P2039", "23P01", "other_exclusion"),
      new Error("appointments_no_overlap 23P01"),
      {},
      null,
    ]) {
      expect(isAppointmentOverlap(error)).toBe(false);
    }
  });

  it("retries a serialization failure and returns the operation result", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(knownError("P2034"))
      .mockResolvedValue("confirmed");
    await expect(retryTransaction(operation)).resolves.toBe("confirmed");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each(["40001", "40P01"])("retries raw SQL transaction conflict %s", async (code) => {
    const error = new Prisma.PrismaClientKnownRequestError("Raw query failed", {
      code: "P2010",
      clientVersion: "7.10.0",
      meta: {
        driverAdapterError: { cause: { originalCode: code, kind: "TransactionWriteConflict" } },
      },
    });
    const operation = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("confirmed");
    await expect(retryTransaction(operation)).resolves.toBe("confirmed");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("bounds retries at three and propagates exhausted conflicts", async () => {
    const error = knownError("P2034");
    const operation = vi.fn().mockRejectedValue(error);
    await expect(retryTransaction(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry or relabel unrelated database failures", async () => {
    const error = knownError("P2002");
    const operation = vi.fn().mockRejectedValue(error);
    await expect(retryTransaction(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
