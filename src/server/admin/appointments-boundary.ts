import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { getActiveAdmin } from "../../modules/auth/server/auth-service";
import {
  appointmentIdSchema,
  journalQuerySchema,
  detailQuerySchema,
  changeStatusSchema,
  allowedTransition,
  statusTimeAllowed,
  type AppointmentFailure,
} from "../../modules/appointments/domain/admin-input";
import { readAppointment, readJournal } from "../../modules/appointments/server/admin-appointments";
import { settingsSelect, businessContextHash } from "../../modules/settings/server/context";
import { validOrigin } from "../public/security";

type MutationResult =
  { ok: true; status: "SCHEDULED" | "COMPLETED" | "NO_SHOW" | "CANCELLED" } | AppointmentFailure;
export function createAppointmentsBoundary(db: PrismaClient) {
  async function read<T>(
    token: unknown,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T | AppointmentFailure> {
    try {
      const result = await db.$transaction(
        async (tx) => {
          if (!(await getActiveAdmin(tx, token)))
            return { ok: false as const, code: "UNAUTHORIZED" as const };
          return operation(tx);
        },
        { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 10000 },
      );
      // Release the snapshot connection before the fresh auth query uses the same pool.
      // Keep the read data private until this final check succeeds.
      if (!(await getActiveAdmin(db, token))) return { ok: false, code: "UNAUTHORIZED" };
      return result;
    } catch {
      return { ok: false, code: "UNAVAILABLE" };
    }
  }
  return {
    list: (token: unknown, raw: unknown) =>
      read(token, async (tx) => {
        const parsed = journalQuerySchema.safeParse(raw);
        return parsed.success
          ? readJournal(tx, parsed.data)
          : { ok: false as const, code: "INVALID_INPUT" as const };
      }),
    detail: (token: unknown, rawId: unknown, raw: unknown) =>
      read(token, async (tx) => {
        const id = appointmentIdSchema.safeParse(rawId),
          query = detailQuerySchema.safeParse(raw);
        return id.success && query.success
          ? readAppointment(tx, id.data, query.data)
          : { ok: false as const, code: "INVALID_INPUT" as const };
      }),
    async change(headers: Headers, token: unknown, raw: unknown): Promise<MutationResult> {
      if (!validOrigin(headers)) return { ok: false, code: "FORBIDDEN" };
      try {
        return await db.$transaction(
          async (tx): Promise<MutationResult> => {
            if (!(await getActiveAdmin(tx, token))) return { ok: false, code: "UNAUTHORIZED" };
            const parsed = changeStatusSchema.safeParse(raw);
            if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
            const input = parsed.data;
            // Same administrative lock order as settings, then the shared appointment row.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(526008, 52)`;
            await tx.$queryRaw`SELECT id FROM business_settings WHERE id = 1 FOR SHARE`;
            await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${input.id}::uuid FOR UPDATE`;
            const admin = await getActiveAdmin(tx, token);
            if (!admin) return { ok: false, code: "UNAUTHORIZED" };
            const settings = await tx.businessSettings.findUniqueOrThrow({
              where: { id: 1 },
              select: settingsSelect,
            });
            const current = await tx.appointment.findUnique({
              where: { id: input.id },
              select: { version: true, status: true, startsAt: true },
            });
            if (!current) return { ok: false, code: "NOT_FOUND" };
            if (
              current.version !== input.version ||
              businessContextHash(settings) !== input.expectedBusinessContext
            )
              return { ok: false, code: "CONFLICT" };
            if (!allowedTransition(current.status, input.status))
              return { ok: false, code: "INVALID_TRANSITION" };
            if (input.status === "CANCELLED" && !input.confirmed)
              return { ok: false, code: "CONFIRMATION_REQUIRED" };
            if (input.status !== "CANCELLED" && input.reason)
              return { ok: false, code: "INVALID_INPUT" };
            // PostgreSQL wall time AFTER every lock wait, never transaction start or browser time.
            const [{ now }] = await tx.$queryRaw<
              Array<{ now: Date }>
            >`SELECT clock_timestamp() AS now`;
            if (!statusTimeAllowed(input.status, current.startsAt, now))
              return { ok: false, code: "NOT_STARTED" };
            const reason = input.reason || null;
            await tx.appointment.update({
              where: { id: input.id, version: input.version },
              data: {
                status: input.status,
                version: { increment: 1 },
                ...(input.status === "CANCELLED"
                  ? { cancelledAt: now, cancelledBy: "ADMIN", cancellationReason: reason }
                  : {}),
              },
              select: { id: true },
            });
            await tx.appointmentStatusHistory.create({
              data: {
                appointmentId: input.id,
                previousStatus: current.status,
                newStatus: input.status,
                changedAt: now,
                changedBy: "ADMIN",
                changedByAdminId: admin.id,
                reason,
              },
              select: { id: true },
            });
            return { ok: true, status: input.status };
          },
          { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 },
        );
      } catch {
        // Unknown COMMIT outcome: no retries and no guessed success/current version.
        return { ok: false, code: "UNAVAILABLE" };
      }
    },
  };
}
