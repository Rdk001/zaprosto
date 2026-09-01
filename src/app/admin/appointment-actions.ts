"use server";
import { cookies, headers } from "next/headers";
import { sessionCookie } from "../../modules/auth/policy";
import { appointmentsBoundary } from "../../server/admin/appointments";
export async function changeAppointmentStatusAction(input: unknown) {
  try {
    return await appointmentsBoundary.change(
      await headers(),
      (await cookies()).get(sessionCookie().name)?.value,
      input,
    );
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
