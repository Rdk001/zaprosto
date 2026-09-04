import type { Prisma } from "../../../generated/prisma/client";
import { readBookingCatalog } from "../../booking/server/booking-catalog";

interface ReschedulableAppointment {
  status: "SCHEDULED" | "COMPLETED" | "NO_SHOW" | "CANCELLED";
  serviceId: string;
}

export async function readAppointmentRescheduleForm(
  tx: Prisma.TransactionClient,
  appointment: ReschedulableAppointment,
) {
  if (appointment.status !== "SCHEDULED") return null;

  const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const catalog = await readBookingCatalog(tx, now);
  const historicalMasters = await tx.master.findMany({
    where: {
      isActive: true,
      services: { some: { serviceId: appointment.serviceId } },
    },
    orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
  if (!catalog) throw new Error("Business settings are not configured");
  return { catalog, historicalMasters };
}
