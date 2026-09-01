import "server-only";
import { cookies } from "next/headers";
import { sessionCookie } from "../../modules/auth/policy";
import { prisma } from "../db/prisma";
import { createAppointmentsBoundary } from "./appointments-boundary";
import { createAdminBookingService } from "../../modules/booking/server/admin-booking-service";
import { createAppointmentCreationBoundary } from "./appointment-creation-boundary";
export const appointmentsBoundary = createAppointmentsBoundary(prisma);
export const appointmentCreationBoundary = createAppointmentCreationBoundary({
  database: prisma,
  booking: createAdminBookingService(prisma),
});
export async function getAdminAppointments(query: unknown) {
  try {
    return await appointmentsBoundary.list(
      (await cookies()).get(sessionCookie().name)?.value,
      query,
    );
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
export async function getAdminAppointment(id: unknown, query: unknown) {
  try {
    return await appointmentsBoundary.detail(
      (await cookies()).get(sessionCookie().name)?.value,
      id,
      query,
    );
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
export async function getAdminAppointmentCreationForm() {
  try {
    return await appointmentCreationBoundary.form(
      (await cookies()).get(sessionCookie().name)?.value,
    );
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
