const REMINDER_LEAD_MS = 2 * 60 * 60_000;
const REMINDER_EXPIRY_MS = 15 * 60_000;

export type ClientAppointmentReminderSchedule = Readonly<{
  scheduledAt: Date;
  expiresAt: Date;
}>;

export function calculateClientAppointmentReminderSchedule(input: {
  startsAt: Date;
  now: Date;
}): ClientAppointmentReminderSchedule | null {
  const startsAtMs = input.startsAt.getTime();
  const nowMs = input.now.getTime();

  if (
    !Number.isFinite(startsAtMs) ||
    !Number.isFinite(nowMs) ||
    startsAtMs - nowMs <= REMINDER_LEAD_MS
  ) {
    return null;
  }

  const scheduledAt = new Date(startsAtMs - REMINDER_LEAD_MS);

  return {
    scheduledAt,
    expiresAt: new Date(scheduledAt.getTime() + REMINDER_EXPIRY_MS),
  };
}
