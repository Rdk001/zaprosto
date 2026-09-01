import "server-only";
import { cookies } from "next/headers";
import { sessionCookie } from "../../modules/auth/policy";
import { prisma } from "../db/prisma";
import { createAppointmentsBoundary } from "./appointments-boundary";
export const appointmentsBoundary = createAppointmentsBoundary(prisma);
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
