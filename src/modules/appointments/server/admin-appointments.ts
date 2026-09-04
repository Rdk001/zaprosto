import type { Prisma } from "../../../generated/prisma/client";
import { readAppointmentRescheduleForm } from "./admin-reschedule-form";
import { settingsSelect, businessContextHash } from "../../settings/server/context";
import { getLocalDayInterval, localDateForInstant } from "../../scheduling/time/business-time";
import { InvalidLocalDateTimeError } from "../../scheduling/domain/errors";
import { PAGE_SIZE, type JournalQuery, type DetailQuery } from "../domain/admin-input";

const masterSelect = { id: true, name: true, isActive: true } as const;
export const appointmentSelect = {
  id: true,
  version: true,
  startsAt: true,
  endsAt: true,
  status: true,
  source: true,
  clientName: true,
  clientPhone: true,
  serviceId: true,
  masterId: true,
  masterSelection: true,
  serviceNameSnapshot: true,
  servicePriceSnapshot: true,
  serviceDurationSnapshot: true,
  cancelledAt: true,
  cancelledBy: true,
  cancellationReason: true,
  master: { select: masterSelect },
} satisfies Prisma.AppointmentSelect;

export async function readJournal(tx: Prisma.TransactionClient, query: JournalQuery) {
  const settings = await tx.businessSettings.findUniqueOrThrow({
    where: { id: 1 },
    select: settingsSelect,
  });
  const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const date = query.date ?? localDateForInstant(now, settings.timezone);
  let day;
  try {
    day = getLocalDayInterval(date, settings.timezone);
  } catch (error) {
    if (error instanceof InvalidLocalDateTimeError)
      return { ok: false as const, code: "INVALID_DAY" as const };
    throw error;
  }
  const masters = await tx.master.findMany({
    select: masterSelect,
    orderBy: { id: "asc" },
    take: 51,
    ...(query.mastersAfter ? { where: { id: { gt: query.mastersAfter } } } : {}),
  });
  const nextMasters = masters.length > 50 ? masters[49].id : null;
  masters.splice(50);
  if (query.masterId && !masters.some((m) => m.id === query.masterId)) {
    const selected = await tx.master.findUnique({
      where: { id: query.masterId },
      select: masterSelect,
    });
    if (!selected) return { ok: false as const, code: "NOT_FOUND" as const };
    masters.unshift(selected);
  }
  const rows = await tx.appointment.findMany({
    where: {
      startsAt: { gte: day.startsAt, lt: day.endsAt },
      ...(query.masterId ? { masterId: query.masterId } : {}),
      ...(query.status === "ALL"
        ? {}
        : { status: query.status === "ACTIVE" ? { not: "CANCELLED" } : query.status }),
    },
    // Contacts beyond the displayed client name are deliberately absent from the journal.
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      clientName: true,
      serviceNameSnapshot: true,
      servicePriceSnapshot: true,
      serviceDurationSnapshot: true,
      master: { select: masterSelect },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    skip: (query.page - 1) * PAGE_SIZE,
    take: PAGE_SIZE + 1,
  });
  return {
    ok: true as const,
    journal: {
      query: { ...query, date },
      timezone: settings.timezone,
      masters,
      nextMasters,
      hasNext: rows.length > PAGE_SIZE,
      appointments: rows.slice(0, PAGE_SIZE),
    },
  };
}
export async function readAppointment(
  tx: Prisma.TransactionClient,
  id: string,
  query: DetailQuery,
) {
  const settings = await tx.businessSettings.findUniqueOrThrow({
    where: { id: 1 },
    select: settingsSelect,
  });
  const appointment = await tx.appointment.findUnique({ where: { id }, select: appointmentSelect });
  if (!appointment) return { ok: false as const, code: "NOT_FOUND" as const };
  const reschedule = await readAppointmentRescheduleForm(tx, appointment);
  const history = await tx.appointmentStatusHistory.findMany({
    where: { appointmentId: id },
    select: {
      id: true,
      previousStatus: true,
      newStatus: true,
      changedAt: true,
      changedBy: true,
      changedByAdminId: true,
      reason: true,
    },
    orderBy: [{ changedAt: "asc" }, { id: "asc" }],
    skip: (query.historyPage - 1) * PAGE_SIZE,
    take: PAGE_SIZE + 1,
  });
  return {
    ok: true as const,
    detail: {
      appointment,
      timezone: settings.timezone,
      businessContext: businessContextHash(settings),
      reschedule,
      query: {
        ...query,
        date: query.date ?? localDateForInstant(appointment.startsAt, settings.timezone),
      },
      history: history.slice(0, PAGE_SIZE),
      hasNextHistory: history.length > PAGE_SIZE,
    },
  };
}
export type AdminAppointment = Prisma.AppointmentGetPayload<{ select: typeof appointmentSelect }>;
