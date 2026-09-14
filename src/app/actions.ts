"use server";
import { headers } from "next/headers";
import { publicBooking } from "../server/public";
import { publicTelegram } from "../server/public";
import { prisma } from "../server/db/prisma";
export async function prepareAttemptAction() {
  return publicBooking.prepare(await headers());
}
export async function createBookingAction(input: unknown) {
  return publicBooking.create(await headers(), input);
}
export async function lookupAppointmentAction(token: unknown) {
  const result = await publicBooking.lookup(await headers(), token);
  if (!result.ok) return result;
  try {
    const settings = await prisma.businessSettings.findUniqueOrThrow({
      where: { id: 1 },
      select: { timezone: true },
    });
    return { ...result, timeZone: settings.timezone };
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
export async function cancelBookingAction(input: unknown) {
  return publicBooking.cancel(await headers(), input);
}
export async function getAppointmentTelegramStateAction(token: unknown) {
  return publicTelegram.state(token);
}
export async function issueAppointmentTelegramLinkAction(token: unknown) {
  return publicTelegram.issue(await headers(), token);
}
export async function revokeAppointmentTelegramLinkAction(token: unknown) {
  return publicTelegram.revoke(await headers(), token);
}
export async function disconnectAppointmentTelegramAction(token: unknown) {
  return publicTelegram.disconnect(await headers(), token);
}
