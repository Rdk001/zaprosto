import { Temporal } from "temporal-polyfill";
import type { Prisma } from "../../../generated/prisma/client";
import {
  databaseInterval,
  displayInterval,
  normalizeScheduleIntervals,
  MAX_DAY_INTERVALS,
  type ScheduleFailure,
  type ScheduleQuery,
  type ScheduleWeek,
  saveWeekSchema,
  saveExceptionSchema,
  deleteExceptionSchema,
  scheduleIssues,
} from "../domain/admin-input";
import {
  assertValidTimeZone,
  localDateForInstant,
  localScheduleIntervalToUtc,
} from "../time/business-time";

const orderBy = [{ startsAt: "asc" as const }, { endsAt: "asc" as const }];
const intervalSelect = { startsAt: true, endsAt: true } as const;
const masterSelect = { id: true, name: true, isActive: true, version: true } as const;
export type AdminException = {
  id: string;
  localDate: string;
  type: "DAY_OFF" | "CUSTOM_HOURS";
  intervals: ReturnType<typeof displayInterval>[];
};
export type ScheduleMutationResult =
  | ScheduleFailure
  | {
      ok: true;
      version: number;
      days?: ScheduleWeek;
      exception?: AdminException;
      deletedId?: string;
    };

export async function readAdminSchedule(tx: Prisma.TransactionClient, query: ScheduleQuery) {
  const settings = await tx.businessSettings.findUniqueOrThrow({
    where: { id: 1 },
    select: { timezone: true },
  });
  const timezone = assertValidTimeZone(settings.timezone);
  const month = query.month ?? localDateForInstant(new Date(), timezone).slice(0, 7);
  const start = Temporal.PlainDate.from(`${month}-01`);
  const masters = await tx.master.findMany({
    select: masterSelect,
    orderBy: { id: "asc" },
    take: 51,
    ...(query.after ? { where: { id: { gt: query.after } } } : {}),
  });
  const nextAfter = masters.length > 50 ? masters[49].id : null;
  masters.splice(50);
  const masterId = query.masterId ?? masters[0]?.id;
  const selected = masterId
    ? await tx.master.findUnique({ where: { id: masterId }, select: masterSelect })
    : null;
  if (masterId && !selected) return { ok: false as const, code: "NOT_FOUND" as const };
  const days: ScheduleWeek = Array.from({ length: 7 }, (_, i) => ({
    dayOfWeek: i + 1,
    work: [],
    breaks: [],
  }));
  let exceptions: AdminException[] = [];
  if (selected) {
    const work = await tx.weeklyWorkInterval.findMany({
      where: { masterId },
      select: { dayOfWeek: true, ...intervalSelect },
      orderBy,
      take: 113,
    });
    const breaks = await tx.weeklyBreak.findMany({
      where: { masterId },
      select: { dayOfWeek: true, ...intervalSelect },
      orderBy,
      take: 113,
    });
    for (const [kind, rows] of [
      ["work", work],
      ["breaks", breaks],
    ] as const) {
      for (const row of rows) days[row.dayOfWeek - 1][kind].push(displayInterval(row));
      if (days.some((day) => day[kind].length > MAX_DAY_INTERVALS))
        return { ok: false as const, code: "LIMIT_EXCEEDED" as const };
    }
    const rows = await tx.scheduleException.findMany({
      where: {
        masterId,
        localDate: {
          gte: new Date(`${start}T00:00:00Z`),
          lt: new Date(`${start.add({ months: 1 })}T00:00:00Z`),
        },
      },
      orderBy: { localDate: "asc" },
      take: 31,
      select: {
        id: true,
        localDate: true,
        type: true,
        intervals: { select: intervalSelect, orderBy, take: MAX_DAY_INTERVALS + 1 },
      },
    });
    if (rows.some((row) => row.intervals.length > MAX_DAY_INTERVALS))
      return { ok: false as const, code: "LIMIT_EXCEEDED" as const };
    exceptions = rows.map((row) => ({
      ...row,
      localDate: row.localDate.toISOString().slice(0, 10),
      intervals: row.type === "DAY_OFF" ? [] : row.intervals.map(displayInterval),
    }));
  }
  return {
    ok: true as const,
    schedule: {
      timezone,
      month,
      masters,
      nextAfter,
      selected: selected ? { ...selected, days } : null,
      exceptions,
    },
  };
}
export type AdminSchedule = Extract<
  Awaited<ReturnType<typeof readAdminSchedule>>,
  { ok: true }
>["schedule"];

async function checkVersion(
  tx: Prisma.TransactionClient,
  masterId: string,
  version: number,
): Promise<ScheduleFailure | null> {
  const master = await tx.master.findUnique({ where: { id: masterId }, select: { version: true } });
  if (!master) return { ok: false, code: "NOT_FOUND" };
  return master.version === version ? null : { ok: false, code: "CONFLICT" };
}
async function incrementVersion(tx: Prisma.TransactionClient, masterId: string) {
  return (
    await tx.master.update({
      where: { id: masterId },
      data: { version: { increment: 1 } },
      select: { version: true },
    })
  ).version;
}
// All mutations run under the same lock as catalog writes, with a fresh session check.
export async function saveWeek(
  tx: Prisma.TransactionClient,
  raw: unknown,
): Promise<ScheduleMutationResult> {
  const parsed = saveWeekSchema.safeParse(raw);
  if (!parsed.success) return scheduleIssues(parsed.error);
  const { masterId, version } = parsed.data;
  const conflict = await checkVersion(tx, masterId, version);
  if (conflict) return conflict;
  const days = parsed.data.days
    .map((day) => ({
      ...day,
      work: normalizeScheduleIntervals(day.work),
      breaks: normalizeScheduleIntervals(day.breaks),
    }))
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek);
  await tx.weeklyWorkInterval.deleteMany({ where: { masterId } });
  await tx.weeklyBreak.deleteMany({ where: { masterId } });
  await tx.weeklyWorkInterval.createMany({
    data: days.flatMap((day) =>
      day.work.map((interval) => ({
        masterId,
        dayOfWeek: day.dayOfWeek,
        ...databaseInterval(interval),
      })),
    ),
  });
  await tx.weeklyBreak.createMany({
    data: days.flatMap((day) =>
      day.breaks.map((interval) => ({
        masterId,
        dayOfWeek: day.dayOfWeek,
        ...databaseInterval(interval),
      })),
    ),
  });
  return { ok: true, version: await incrementVersion(tx, masterId), days };
}
export async function saveException(
  tx: Prisma.TransactionClient,
  raw: unknown,
): Promise<ScheduleMutationResult> {
  const parsed = saveExceptionSchema.safeParse(raw);
  if (!parsed.success) return scheduleIssues(parsed.error);
  const { masterId, version, id, localDate, type } = parsed.data;
  const conflict = await checkVersion(tx, masterId, version);
  if (conflict) return conflict;
  if (
    id &&
    !(await tx.scheduleException.findFirst({ where: { id, masterId }, select: { id: true } }))
  )
    return { ok: false, code: "NOT_FOUND" };
  const date = new Date(`${localDate}T00:00:00.000Z`);
  const existing = await tx.scheduleException.findUnique({
    where: { masterId_localDate: { masterId, localDate: date } },
    select: { id: true },
  });
  if (existing && existing.id !== id) return { ok: false, code: "CONFLICT" };
  const settings = await tx.businessSettings.findUniqueOrThrow({
    where: { id: 1 },
    select: { timezone: true },
  });
  // Validate every supplied boundary BEFORE merging: normalization must not hide invalid DST times.
  if (type === "CUSTOM_HOURS") {
    for (const interval of parsed.data.intervals) {
      const { startsAt, endsAt } = databaseInterval(interval);
      localScheduleIntervalToUtc(localDate, startsAt, endsAt, settings.timezone);
    }
    // Weekly breaks remain effective on this date; DAY_OFF deliberately never resolves them.
    const breaks = await tx.weeklyBreak.findMany({
      where: { masterId, dayOfWeek: Temporal.PlainDate.from(localDate).dayOfWeek },
      select: intervalSelect,
      take: MAX_DAY_INTERVALS + 1,
    });
    if (breaks.length > MAX_DAY_INTERVALS) return { ok: false, code: "LIMIT_EXCEEDED" };
    for (const interval of breaks)
      localScheduleIntervalToUtc(localDate, interval.startsAt, interval.endsAt, settings.timezone);
  }
  const intervals = normalizeScheduleIntervals(parsed.data.intervals);
  let savedId = id;
  if (id) {
    await tx.exceptionWorkInterval.deleteMany({ where: { scheduleExceptionId: id } });
    await tx.scheduleException.update({ where: { id }, data: { localDate: date, type } });
  } else {
    savedId = (
      await tx.scheduleException.create({
        data: { masterId, localDate: date, type },
        select: { id: true },
      })
    ).id;
  }
  await tx.exceptionWorkInterval.createMany({
    data: intervals.map((interval) => ({
      scheduleExceptionId: savedId!,
      ...databaseInterval(interval),
    })),
  });
  return {
    ok: true,
    version: await incrementVersion(tx, masterId),
    exception: { id: savedId!, localDate, type, intervals },
  };
}
export async function deleteException(
  tx: Prisma.TransactionClient,
  raw: unknown,
): Promise<ScheduleMutationResult> {
  const parsed = deleteExceptionSchema.safeParse(raw);
  if (!parsed.success) return scheduleIssues(parsed.error);
  const { masterId, version, id } = parsed.data;
  const conflict = await checkVersion(tx, masterId, version);
  if (conflict) return conflict;
  const existing = await tx.scheduleException.findFirst({
    where: { id, masterId },
    select: { id: true },
  });
  if (!existing) return { ok: false, code: "NOT_FOUND" };
  await tx.scheduleException.delete({ where: { id } });
  return { ok: true, version: await incrementVersion(tx, masterId), deletedId: id };
}
