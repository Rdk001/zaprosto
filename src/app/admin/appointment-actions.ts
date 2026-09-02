"use server";
import { cookies, headers } from "next/headers";
import { sessionCookie } from "../../modules/auth/policy";
import { appointmentCreationBoundary, appointmentsBoundary } from "../../server/admin/appointments";
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

export async function updateAppointmentContactsAction(input: unknown) {
  try {
    return await appointmentsBoundary.updateContacts(
      await headers(),
      (await cookies()).get(sessionCookie().name)?.value,
      input,
    );
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}

async function sessionToken() {
  return (await cookies()).get(sessionCookie().name)?.value;
}

export async function getAdminAppointmentAvailabilityAction(input: unknown) {
  try {
    return await appointmentCreationBoundary.availability(await sessionToken(), input);
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}

export async function prepareAdminAppointmentAction() {
  try {
    return await appointmentCreationBoundary.prepare(await headers(), await sessionToken());
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}

export async function createAdminAppointmentAction(input: unknown) {
  try {
    return await appointmentCreationBoundary.create(await headers(), await sessionToken(), input);
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
