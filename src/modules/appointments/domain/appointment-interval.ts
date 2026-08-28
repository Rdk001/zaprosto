import { z } from "zod";

export const appointmentIntervalSchema = z
  .object({
    startsAt: z.date(),
    endsAt: z.date(),
  })
  .refine(({ startsAt, endsAt }) => startsAt < endsAt, {
    message: "Начало записи должно быть раньше окончания",
    path: ["endsAt"],
  });
