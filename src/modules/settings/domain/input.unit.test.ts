import { describe, expect, it } from "vitest";
import { settingsSchema } from "./input";
import { businessContextHash, publicTimeContext } from "../server/context";
import { getBookingDateContext, getLocalDayInterval } from "../../scheduling/time/business-time";
const valid = {
  version: 0,
  bookingHorizonDays: "30",
  timezone: "Europe/Moscow",
  confirmedTimezoneChange: false,
};
describe("настройки времени", () => {
  it.each(["7", "90"])("граница %s", (value) =>
    expect(settingsSchema.parse({ ...valid, bookingHorizonDays: value }).bookingHorizonDays).toBe(
      Number(value),
    ),
  );
  it.each([
    "",
    "6",
    "91",
    "30.5",
    "-7",
    "7e0",
    " 7",
    "07",
    "7 ",
    7,
    7.5,
    null,
    undefined,
    {},
    Infinity,
  ])("отклоняет неверный горизонт %j", (value) =>
    expect(settingsSchema.safeParse({ ...valid, bookingHorizonDays: value }).success).toBe(false),
  );
  it.each([
    "Europe/Moscow",
    "Europe/Berlin",
    "America/New_York",
    "Asia/Kathmandu",
    "Pacific/Chatham",
    "UTC",
    "Etc/GMT+3",
  ])("именованная зона %s", (timezone) =>
    expect(settingsSchema.safeParse({ ...valid, timezone }).success).toBe(true),
  );
  it.each([
    "",
    "Mars/Olympus",
    " Europe/Moscow",
    "Europe/Moscow ",
    "+03:00",
    "-0500",
    "+03:00:30",
    "Z",
    "x".repeat(101),
    null,
    {},
  ])("отклоняет зону %j", (timezone) =>
    expect(settingsSchema.safeParse({ ...valid, timezone }).success).toBe(false),
  );
  it.each([
    { id: 1 },
    { businessName: "Другой" },
    { version: -1 },
    { version: 0.5 },
    { version: 2147483648 },
    { confirmedTimezoneChange: "true" },
  ])("поля и версия %j", (extra) =>
    expect(settingsSchema.safeParse({ ...valid, ...extra }).success).toBe(false),
  );
  it("пустой объект и отсутствие подтверждения", () => {
    expect(settingsSchema.safeParse({}).success).toBe(false);
    expect(settingsSchema.safeParse({ ...valid, confirmedTimezoneChange: undefined }).success).toBe(
      false,
    );
  });
  it("контекст защищён от ABA", () => {
    const settings = { version: 0, timezone: "Europe/Moscow", bookingHorizonDays: 30 };
    expect(businessContextHash(settings)).not.toBe(
      businessContextHash({ ...settings, version: 2 }),
    );
  });
  it("локальная полночь и N календарных дней включая сегодня", () => {
    const settings = { version: 3, timezone: "Asia/Kathmandu", bookingHorizonDays: 7 };
    const before = publicTimeContext(settings, new Date("2026-10-01T18:14:59Z"));
    const after = publicTimeContext(settings, new Date("2026-10-01T18:15:00Z"));
    expect(before.dates).toHaveLength(7);
    expect(before.dates[0]).toBe("2026-10-01");
    expect(after.dates).toEqual([
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
    ]);
    expect(() =>
      getBookingDateContext("2026-10-09", settings.timezone, 7, new Date("2026-10-01T18:15Z")),
    ).toThrow();
  });
  it.each([
    ["2026-03-29", 23],
    ["2026-10-25", 25],
  ] as const)("DST: %s не превращает дни в 24-часовые интервалы", (date, hours) => {
    const day = getLocalDayInterval(date, "Europe/Berlin");
    expect((day.endsAt.getTime() - day.startsAt.getTime()) / 3600000).toBe(hours);
    const context = publicTimeContext(
      { version: 0, timezone: "Europe/Berlin", bookingHorizonDays: 7 },
      day.startsAt,
    );
    expect(context.dates[0]).toBe(date);
    expect(context.dates).toHaveLength(7);
  });
});
