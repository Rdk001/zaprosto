import { z } from "zod";

export const positivePriceKopecksSchema = z
  .number()
  .int("Цена должна быть указана в целых копейках")
  .positive("Цена должна быть положительной");

export const serviceDurationMinutesSchema = z
  .number()
  .int("Длительность должна быть указана в целых минутах")
  .positive("Длительность должна быть положительной");
