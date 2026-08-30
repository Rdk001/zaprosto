import type { Prisma } from "../../../generated/prisma/client";

export const confirmationSelect = {
  id: true,
  status: true,
  startsAt: true,
  endsAt: true,
  clientName: true,
  clientPhone: true,
  serviceId: true,
  serviceNameSnapshot: true,
  servicePriceSnapshot: true,
  serviceDurationSnapshot: true,
  master: { select: { id: true, name: true } },
  cancelledAt: true,
  cancelledBy: true,
  cancellationReason: true,
} satisfies Prisma.AppointmentSelect;

type ConfirmationRow = Prisma.AppointmentGetPayload<{ select: typeof confirmationSelect }>;

export function toConfirmation(row: ConfirmationRow) {
  return {
    id: row.id,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    clientName: row.clientName,
    clientPhone: row.clientPhone,
    master: row.master,
    service: {
      id: row.serviceId,
      name: row.serviceNameSnapshot,
      priceKopecks: row.servicePriceSnapshot,
      durationMinutes: row.serviceDurationSnapshot,
    },
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
    cancellationReason: row.cancellationReason,
  };
}

export type AppointmentConfirmation = ReturnType<typeof toConfirmation>;
