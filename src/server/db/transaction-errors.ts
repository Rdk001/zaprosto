import { Prisma } from "../../generated/prisma/client";

function adapterCause(error: Prisma.PrismaClientKnownRequestError): Record<string, unknown> | null {
  const adapter = error.meta?.driverAdapterError;
  if (!adapter || typeof adapter !== "object" || !("cause" in adapter)) return null;
  const cause = adapter.cause;
  return cause && typeof cause === "object" ? (cause as Record<string, unknown>) : null;
}

export function isAppointmentOverlap(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2039")
    return false;
  const cause = adapterCause(error);
  // adapter-pg 7.10 drops the constraint field for 23P01, but retains its exact message.
  // Never classify all P2039/P2004 errors, or all exclusions, as an appointment overlap.
  return (
    cause?.code === "23P01" &&
    cause.message ===
      'conflicting key value violates exclusion constraint "appointments_no_overlap"'
  );
}

function isTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010") return false;
  const cause = adapterCause(error);
  // Raw INSERT ... ON CONFLICT returns P2010 with the SQLSTATE nested in the adapter.
  return (
    cause?.kind === "TransactionWriteConflict" &&
    (cause.originalCode === "40001" || cause.originalCode === "40P01")
  );
}

export async function retryTransaction<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransactionConflict(error) || attempt >= 3) throw error;
    }
  }
}
