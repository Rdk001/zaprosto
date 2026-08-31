import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { getActiveAdmin } from "../../modules/auth/server/auth-service";
import {
  scheduleIssues,
  scheduleQuerySchema,
  type ScheduleFailure,
} from "../../modules/scheduling/domain/admin-input";
import { SchedulingError, InvalidLocalDateTimeError } from "../../modules/scheduling/domain/errors";
import {
  readAdminSchedule,
  saveWeek,
  saveException,
  deleteException,
  type ScheduleMutationResult,
} from "../../modules/scheduling/server/admin-schedule";
import { validOrigin } from "../public/security";

export function createScheduleBoundary(db: PrismaClient) {
  async function run<T>(
    token: unknown,
    write: boolean,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T | ScheduleFailure> {
    try {
      return await db.$transaction(
        async (tx) => {
          if (!(await getActiveAdmin(tx, token)))
            return { ok: false as const, code: "UNAUTHORIZED" as const };
          if (write) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(526008, 52)`;
            if (!(await getActiveAdmin(tx, token)))
              return { ok: false as const, code: "UNAUTHORIZED" as const };
          }
          return operation(tx);
        },
        {
          isolationLevel: write ? "ReadCommitted" : "RepeatableRead",
          maxWait: 5000,
          timeout: 10000,
        },
      );
    } catch (error) {
      if (error instanceof SchedulingError)
        return {
          ok: false,
          code: "INVALID_TIME",
          fields: {
            form:
              error instanceof InvalidLocalDateTimeError
                ? `Время ${error.localTime} на дату ${error.localDate} не существует или неоднозначно в зоне ${error.timeZone}. Выберите другие границы.`
                : "Проверьте дату, время и настройку часового пояса бизнеса.",
          },
        };
      // No retry: even a lost COMMIT acknowledgement must preserve the administrator's draft.
      return { ok: false, code: "UNAVAILABLE" };
    }
  }
  function mutate(
    headers: Headers,
    token: unknown,
    input: unknown,
    operation: (tx: Prisma.TransactionClient, input: unknown) => Promise<ScheduleMutationResult>,
  ) {
    return validOrigin(headers)
      ? run(token, true, (tx) => operation(tx, input))
      : Promise.resolve({ ok: false as const, code: "FORBIDDEN" as const });
  }
  return {
    read: (token: unknown, query: unknown = {}) =>
      run(token, false, async (tx) => {
        const parsed = scheduleQuerySchema.safeParse(query);
        return parsed.success ? readAdminSchedule(tx, parsed.data) : scheduleIssues(parsed.error);
      }),
    saveWeek: (headers: Headers, token: unknown, input: unknown) =>
      mutate(headers, token, input, saveWeek),
    saveException: (headers: Headers, token: unknown, input: unknown) =>
      mutate(headers, token, input, saveException),
    deleteException: (headers: Headers, token: unknown, input: unknown) =>
      mutate(headers, token, input, deleteException),
  };
}
