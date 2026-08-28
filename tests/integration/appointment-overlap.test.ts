import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../../src/server/db/create-prisma-client";

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for integration tests");
}

const firstClient = createPrismaClient(connectionString);
const secondClient = createPrismaClient(connectionString);

type DatabaseConflict = "overlap" | "deadlock";

function databaseErrorDetails(error: unknown): string {
  const seen = new Set<object>();

  function visit(value: unknown, depth: number): string[] {
    if (value === null || value === undefined || depth > 8) {
      return [];
    }

    if (typeof value === "string" || typeof value === "number") {
      return [String(value)];
    }

    if (typeof value !== "object" || seen.has(value)) {
      return [];
    }

    seen.add(value);
    const record = value as Record<string, unknown>;
    const details = value instanceof Error ? [value.name, value.message] : [];
    const keys = new Set([...Object.keys(record), "code", "constraint", "detail", "meta", "cause"]);

    for (const key of keys) {
      if (record[key] !== undefined) {
        details.push(key, ...visit(record[key], depth + 1));
      }
    }

    return details;
  }

  return visit(error, 0).join(" ");
}

function classifyDatabaseConflict(error: unknown): DatabaseConflict | null {
  const details = databaseErrorDetails(error);

  if (/appointments_no_overlap|23P01|\bP2004\b/i.test(details)) {
    return "overlap";
  }

  if (/40P01|deadlock|\bP2034\b/i.test(details)) {
    return "deadlock";
  }

  return null;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

describe("appointment overlap exclusion constraint", () => {
  let masterId: string;
  let serviceId: string;

  const createAttempt = async (
    client: typeof firstClient,
    attempt: string,
    attemptStartsAt: Date,
    attemptEndsAt: Date,
  ) => {
    const bookingRequest = await client.bookingRequest.create({
      data: { idempotencyKey: `integration-${masterId}-${attempt}` },
    });

    return client.appointment.create({
      data: {
        masterId,
        serviceId,
        bookingRequestId: bookingRequest.id,
        startsAt: attemptStartsAt,
        endsAt: attemptEndsAt,
        clientName: "Тестовый Клиент",
        clientPhone: "+79990000000",
        source: "ONLINE",
        masterSelection: "SPECIFIC",
        serviceNameSnapshot: "Тестовая услуга",
        servicePriceSnapshot: 2_000,
        serviceDurationSnapshot: 30,
        cancellationTokenHash: `hash-${randomUUID()}`,
      },
    });
  };

  beforeAll(async () => {
    await Promise.all([firstClient.$connect(), secondClient.$connect()]);

    const suffix = randomUUID();
    const [master, service] = await Promise.all([
      firstClient.master.create({ data: { name: `Integration master ${suffix}` } }),
      firstClient.service.create({
        data: {
          name: `Integration service ${suffix}`,
          priceKopecks: 2_000,
          durationMinutes: 30,
        },
      }),
    ]);

    masterId = master.id;
    serviceId = service.id;
  });

  afterAll(async () => {
    if (masterId) {
      await firstClient.appointment.deleteMany({ where: { masterId } });
      await firstClient.bookingRequest.deleteMany({
        where: { idempotencyKey: { startsWith: `integration-${masterId}-` } },
      });
      await firstClient.master.delete({ where: { id: masterId } });
    }

    if (serviceId) {
      await firstClient.service.delete({ where: { id: serviceId } });
    }

    await Promise.all([firstClient.$disconnect(), secondClient.$disconnect()]);
  });

  it("rejects a deterministic overlap with the appointments_no_overlap constraint", async () => {
    const startsAt = new Date("2030-01-14T07:02:00.000Z");
    const endsAt = new Date("2030-01-14T07:32:00.000Z");

    await createAttempt(firstClient, "deterministic-existing", startsAt, endsAt);

    const rejection = await captureRejection(
      createAttempt(
        secondClient,
        "deterministic-overlap",
        new Date("2030-01-14T07:17:00.000Z"),
        new Date("2030-01-14T07:47:00.000Z"),
      ),
    );
    const details = databaseErrorDetails(rejection);

    expect(rejection, "The overlapping insert unexpectedly succeeded").not.toBeNull();
    expect(classifyDatabaseConflict(rejection), details).toBe("overlap");
  });

  it("allows only one concurrent overlapping appointment and releases a cancelled interval", async () => {
    const startsAt = new Date("2030-01-15T07:02:00.000Z");
    const endsAt = new Date("2030-01-15T07:32:00.000Z");

    const concurrentResults = await Promise.allSettled([
      createAttempt(firstClient, "first", startsAt, endsAt),
      createAttempt(
        secondClient,
        "second",
        new Date("2030-01-15T07:17:00.000Z"),
        new Date("2030-01-15T07:47:00.000Z"),
      ),
    ]);

    const fulfilledResults = concurrentResults.filter(({ status }) => status === "fulfilled");
    const rejectedResults = concurrentResults.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilledResults).toHaveLength(1);
    expect(rejectedResults).toHaveLength(1);

    const rejectedResult = rejectedResults[0];
    if (!rejectedResult) {
      throw new Error("The concurrent overlap did not produce a rejected attempt");
    }

    const conflict = classifyDatabaseConflict(rejectedResult.reason);
    const details = databaseErrorDetails(rejectedResult.reason);

    // Concurrent GiST exclusion checks can surface either the constraint conflict (23P01)
    // or a PostgreSQL deadlock (40P01/P2034). Both are expected booking conflicts that the
    // future application service must translate into a retry/conflict response.
    expect(["overlap", "deadlock"], details).toContain(conflict);

    const blockingAppointments = await firstClient.appointment.findMany({
      where: {
        masterId,
        startsAt: {
          gte: new Date("2030-01-15T00:00:00.000Z"),
          lt: new Date("2030-01-16T00:00:00.000Z"),
        },
        status: { not: "CANCELLED" },
      },
    });
    expect(blockingAppointments).toHaveLength(1);

    await firstClient.appointment.update({
      where: { id: blockingAppointments[0].id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledBy: "SYSTEM",
      },
    });

    await expect(
      createAttempt(firstClient, "after-cancellation", startsAt, endsAt),
    ).resolves.toMatchObject({ status: "SCHEDULED" });
  });
});
