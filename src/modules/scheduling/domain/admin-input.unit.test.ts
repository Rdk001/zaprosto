import { describe, expect, it } from "vitest";
import {
  databaseTime,
  displayInterval,
  intervalSchema,
  localDateSchema,
  normalizeScheduleIntervals,
  saveExceptionSchema,
  saveWeekSchema,
  scheduleQuerySchema,
  type ScheduleWeek,
} from "./admin-input";

const masterId = "00000000-0000-4000-8000-000000000001";
const target = { masterId, version: 0 };
const days = (): ScheduleWeek =>
  Array.from({ length: 7 }, (_, i) => ({ dayOfWeek: i + 1, work: [], breaks: [] }));
describe("ввод административного расписания", () => {
  it.each([
    ["9:00", "10:00"],
    ["09:00:01", "10:00"],
    ["09:00", "09:00"],
    ["20:00", "08:00"],
    ["24:00", "25:00"],
    ["09:60", "10:00"],
    [" 09:00", "10:00"],
  ])("отклоняет границы %s / %s", (start, end) => {
    expect(intervalSchema.safeParse({ start, end }).success).toBe(false);
  });
  it.each([
    "2026-02-29",
    "2026-04-31",
    "2026-1-01",
    "2026-10-05T00:00:00Z",
    "0000-01-01",
    "2026-00-01",
  ])("отклоняет дату %s", (value) => expect(localDateSchema.safeParse(value).success).toBe(false));
  it("точные минуты, календарная дата и UTC-носитель без смещения", () => {
    expect(localDateSchema.parse("2028-02-29")).toBe("2028-02-29");
    expect(intervalSchema.parse({ start: "09:07", end: "09:44" })).toEqual({
      start: "09:07",
      end: "09:44",
    });
    expect(databaseTime("09:07").toISOString()).toBe("1970-01-01T09:07:00.000Z");
    expect(() =>
      displayInterval({
        startsAt: new Date("1970-01-01T09:07:01Z"),
        endsAt: databaseTime("10:00"),
      }),
    ).toThrow();
  });
  it("нормализует дубли, пересечения и соседние интервалы без изменения объединения", () => {
    expect(
      normalizeScheduleIntervals([
        { start: "13:00", end: "14:01" },
        { start: "09:07", end: "10:00" },
        { start: "09:30", end: "11:00" },
        { start: "11:00", end: "12:00" },
        { start: "09:07", end: "10:00" },
      ]),
    ).toEqual([
      { start: "09:07", end: "12:00" },
      { start: "13:00", end: "14:01" },
    ]);
  });
  it("пустая неделя, отдельные перерывы; каждый день только один раз", () => {
    const week = days();
    week[0].breaks = [{ start: "12:00", end: "13:00" }];
    expect(saveWeekSchema.safeParse({ ...target, days: week }).success).toBe(true);
    week[6].dayOfWeek = 1;
    expect(saveWeekSchema.safeParse({ ...target, days: week }).success).toBe(false);
  });
  it("строгие поля, размеры массивов и запросов чтения", () => {
    expect(saveWeekSchema.safeParse({ ...target, days: days(), isActive: true }).success).toBe(
      false,
    );
    const week = days();
    week[0].work = Array.from({ length: 17 }, () => ({ start: "09:00", end: "10:00" }));
    expect(saveWeekSchema.safeParse({ ...target, days: week }).success).toBe(false);
    expect(scheduleQuerySchema.safeParse({ month: "2026-13" }).success).toBe(false);
    expect(scheduleQuerySchema.safeParse({ from: "2026-01-01", to: "9999-12-31" }).success).toBe(
      false,
    );
    const maximum = days().map((day) => ({
      ...day,
      work: week[0].work.slice(0, 16),
      breaks: week[0].work.slice(0, 16),
    }));
    expect(Buffer.byteLength(JSON.stringify([{ ...target, days: maximum }]))).toBeLessThan(
      12 * 1024,
    );
  });
  it("DAY_OFF без скрытых часов, CUSTOM_HOURS не пустой", () => {
    const input = { ...target, id: null, localDate: "2026-10-05", type: "DAY_OFF", intervals: [] };
    expect(saveExceptionSchema.safeParse(input).success).toBe(true);
    expect(saveExceptionSchema.safeParse({ ...input, type: "CUSTOM_HOURS" }).success).toBe(false);
    expect(
      saveExceptionSchema.safeParse({ ...input, intervals: [{ start: "09:00", end: "10:00" }] })
        .success,
    ).toBe(false);
  });
});
