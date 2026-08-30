import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BusinessSettingsNotFoundError,
  InactiveServiceError,
  InvalidLocalDateError,
  InvalidLocalDateTimeError,
  InvalidTimeZoneError,
  ServiceNotFoundError,
} from "../../src/modules/scheduling/domain/errors";
import { createSchedulingAvailabilityService } from "../../src/modules/scheduling/server/availability-service";
import { createPrismaClient } from "../../src/server/db/create-prisma-client";

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for integration tests");
}

const database = createPrismaClient(connectionString);
const suiteId = randomUUID();
const clock = {
  now: () => new Date("2026-10-01T00:00:00.000Z"),
};
const scheduling = createSchedulingAvailabilityService(database, clock);
const createdMasterIds: string[] = [];
const createdServiceIds: string[] = [];

type OriginalSettings = Awaited<ReturnType<typeof database.businessSettings.findUnique>>;

let originalSettings: OriginalSettings;

function databaseTime(time: string): Date {
  return new Date(`1970-01-01T${time}:00.000Z`);
}

function databaseDate(localDate: string): Date {
  return new Date(`${localDate}T00:00:00.000Z`);
}

function slotStarts(result: { slots: Array<{ startsAt: Date }> }): string[] {
  return result.slots.map(({ startsAt }) => startsAt.toISOString());
}

async function configureBusiness(timezone = "Europe/Moscow") {
  await database.businessSettings.upsert({
    where: { id: 1 },
    update: { timezone, bookingHorizonDays: 90 },
    create: {
      id: 1,
      businessName: `Scheduling integration ${suiteId}`,
      timezone,
      bookingHorizonDays: 90,
    },
  });
}

async function createCatalogFixture(options?: {
  durationMinutes?: number;
  masterCount?: number;
  assignMasters?: boolean;
  masterDisplayOrders?: number[];
}) {
  const durationMinutes = options?.durationMinutes ?? 30;
  const masterCount = options?.masterCount ?? 1;
  const service = await database.service.create({
    data: {
      name: `Scheduling service ${suiteId} ${randomUUID()}`,
      priceKopecks: 2_000,
      durationMinutes,
    },
  });
  createdServiceIds.push(service.id);
  const masters = [];

  for (let index = 0; index < masterCount; index += 1) {
    const master = await database.master.create({
      data: {
        name: `Scheduling master ${suiteId} ${randomUUID()}`,
        displayOrder: options?.masterDisplayOrders?.[index] ?? index,
      },
    });
    masters.push(master);
    createdMasterIds.push(master.id);

    if (options?.assignMasters !== false) {
      await database.masterService.create({
        data: { masterId: master.id, serviceId: service.id },
      });
    }
  }

  return { service, masters };
}

async function addWeeklyWork(
  masterId: string,
  dayOfWeek: number,
  startsAt: string,
  endsAt: string,
) {
  return database.weeklyWorkInterval.create({
    data: {
      masterId,
      dayOfWeek,
      startsAt: databaseTime(startsAt),
      endsAt: databaseTime(endsAt),
    },
  });
}

async function addWeeklyBreak(
  masterId: string,
  dayOfWeek: number,
  startsAt: string,
  endsAt: string,
) {
  return database.weeklyBreak.create({
    data: {
      masterId,
      dayOfWeek,
      startsAt: databaseTime(startsAt),
      endsAt: databaseTime(endsAt),
    },
  });
}

async function createAppointment(input: {
  masterId: string;
  serviceId: string;
  startsAt: string;
  endsAt: string;
  status?: "SCHEDULED" | "COMPLETED" | "NO_SHOW" | "CANCELLED";
}) {
  const key = `scheduling-${suiteId}-${randomUUID()}`;
  const bookingRequest = await database.bookingRequest.create({
    data: { idempotencyKey: key },
  });

  return database.appointment.create({
    data: {
      masterId: input.masterId,
      serviceId: input.serviceId,
      bookingRequestId: bookingRequest.id,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      clientName: "Интеграционный Клиент",
      clientPhone: "+79990000000",
      status: input.status ?? "SCHEDULED",
      source: "ADMIN",
      masterSelection: "SPECIFIC",
      serviceNameSnapshot: "Интеграционная услуга",
      servicePriceSnapshot: 2_000,
      serviceDurationSnapshot: 30,
      cancellationTokenHash: `scheduling-hash-${randomUUID()}`,
    },
  });
}

describe("scheduling availability service", () => {
  beforeAll(async () => {
    await database.$connect();
    originalSettings = await database.businessSettings.findUnique({
      where: { id: 1 },
    });
    await configureBusiness();
  });

  afterAll(async () => {
    if (createdMasterIds.length > 0) {
      await database.appointment.deleteMany({
        where: { masterId: { in: createdMasterIds } },
      });
    }
    await database.bookingRequest.deleteMany({
      where: { idempotencyKey: { startsWith: `scheduling-${suiteId}-` } },
    });
    if (createdMasterIds.length > 0) {
      await database.master.deleteMany({
        where: { id: { in: createdMasterIds } },
      });
    }
    if (createdServiceIds.length > 0) {
      await database.service.deleteMany({
        where: { id: { in: createdServiceIds } },
      });
    }

    if (originalSettings) {
      await database.businessSettings.update({
        where: { id: 1 },
        data: {
          businessName: originalSettings.businessName,
          timezone: originalSettings.timezone,
          bookingHorizonDays: originalSettings.bookingHorizonDays,
          logoMediaId: originalSettings.logoMediaId,
        },
      });
    } else {
      await database.businessSettings.deleteMany({ where: { id: 1 } });
    }

    await database.$disconnect();
  });

  it("returns typed errors for missing settings, invalid service, date and time zone", async () => {
    await configureBusiness();

    await expect(
      scheduling.getAnyMasterAvailability({
        serviceId: randomUUID(),
        localDate: "2026-10-05",
      }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
    await expect(
      scheduling.getAnyMasterAvailability({
        serviceId: randomUUID(),
        localDate: "2026-02-30",
      }),
    ).rejects.toBeInstanceOf(InvalidLocalDateError);

    try {
      await configureBusiness("Not/A_Time_Zone");
      await expect(
        scheduling.getAnyMasterAvailability({
          serviceId: randomUUID(),
          localDate: "2026-10-05",
        }),
      ).rejects.toBeInstanceOf(InvalidTimeZoneError);
    } finally {
      await configureBusiness();
    }

    try {
      await database.businessSettings.delete({ where: { id: 1 } });
      await expect(
        scheduling.getAnyMasterAvailability({
          serviceId: randomUUID(),
          localDate: "2026-10-05",
        }),
      ).rejects.toBeInstanceOf(BusinessSettingsNotFoundError);
    } finally {
      await configureBusiness();
    }
  });

  it("returns a typed error for an inactive service", async () => {
    await configureBusiness();
    const { service } = await createCatalogFixture();
    await database.service.update({
      where: { id: service.id },
      data: { isActive: false },
    });

    await expect(
      scheduling.getAnyMasterAvailability({
        serviceId: service.id,
        localDate: "2026-10-05",
      }),
    ).rejects.toBeInstanceOf(InactiveServiceError);
  });

  it("loads real weekly work intervals", async () => {
    await configureBusiness();
    const { service, masters } = await createCatalogFixture();
    const master = masters[0]!;
    await Promise.all([
      addWeeklyWork(master.id, 1, "09:00", "10:00"),
      addWeeklyWork(master.id, 1, "14:00", "15:00"),
    ]);

    const result = await scheduling.getMasterAvailability({
      serviceId: service.id,
      masterId: master.id,
      localDate: "2026-10-05",
    });

    expect(result.workingIntervals).toEqual([
      {
        startsAt: new Date("2026-10-05T06:00:00.000Z"),
        endsAt: new Date("2026-10-05T07:00:00.000Z"),
      },
      {
        startsAt: new Date("2026-10-05T11:00:00.000Z"),
        endsAt: new Date("2026-10-05T12:00:00.000Z"),
      },
    ]);
    expect(slotStarts(result)).toContain("2026-10-05T06:00:00.000Z");
    expect(slotStarts(result)).toContain("2026-10-05T11:30:00.000Z");
  });

  it("applies DAY_OFF and replaces weekly work with CUSTOM_HOURS", async () => {
    await configureBusiness();
    const { service, masters } = await createCatalogFixture();
    const master = masters[0]!;
    await Promise.all([
      addWeeklyWork(master.id, 2, "09:00", "12:00"),
      addWeeklyWork(master.id, 3, "09:00", "12:00"),
      addWeeklyBreak(master.id, 3, "14:00", "14:30"),
      database.scheduleException.create({
        data: {
          masterId: master.id,
          localDate: databaseDate("2026-10-06"),
          type: "DAY_OFF",
        },
      }),
      database.scheduleException.create({
        data: {
          masterId: master.id,
          localDate: databaseDate("2026-10-07"),
          type: "CUSTOM_HOURS",
          intervals: {
            create: [
              {
                startsAt: databaseTime("13:00"),
                endsAt: databaseTime("15:00"),
              },
            ],
          },
        },
      }),
    ]);

    const dayOff = await scheduling.getMasterAvailability({
      serviceId: service.id,
      masterId: master.id,
      localDate: "2026-10-06",
    });
    const customHours = await scheduling.getMasterAvailability({
      serviceId: service.id,
      masterId: master.id,
      localDate: "2026-10-07",
    });

    expect(dayOff.slots).toEqual([]);
    expect(customHours.workingIntervals).toEqual([
      {
        startsAt: new Date("2026-10-07T10:00:00.000Z"),
        endsAt: new Date("2026-10-07T12:00:00.000Z"),
      },
    ]);
    expect(slotStarts(customHours)).not.toContain("2026-10-07T10:45:00.000Z");
    expect(slotStarts(customHours)).toContain("2026-10-07T11:30:00.000Z");
  });

  describe.each([
    {
      localDate: "2026-11-01",
      now: "2026-10-31T12:00:00.000Z",
      invalidStart: "01:30",
      dayStart: "2026-11-01T04:00:00.000Z",
      morningHourUtc: "14",
    },
    {
      localDate: "2026-03-08",
      now: "2026-03-07T12:00:00.000Z",
      invalidStart: "02:30",
      dayStart: "2026-03-08T05:00:00.000Z",
      morningHourUtc: "13",
    },
  ])("DST exception precedence on $localDate", (transition) => {
    const dstScheduling = createSchedulingAvailabilityService(database, {
      now: () => new Date(transition.now),
    });
    const morningStart = (minute: string) =>
      `${transition.localDate}T${transition.morningHourUtc}:${minute}:00.000Z`;

    it("ignores weekly hours and breaks on DAY_OFF while preserving load and other masters", async () => {
      await configureBusiness("America/New_York");
      const { service, masters } = await createCatalogFixture({ masterCount: 2 });
      const [offMaster, workingMaster] = masters;
      await Promise.all([
        addWeeklyWork(offMaster!.id, 7, transition.invalidStart, "03:30"),
        addWeeklyBreak(offMaster!.id, 7, transition.invalidStart, "03:00"),
        addWeeklyWork(workingMaster!.id, 7, "09:00", "10:00"),
        database.scheduleException.create({
          data: {
            masterId: offMaster!.id,
            localDate: databaseDate(transition.localDate),
            type: "DAY_OFF",
          },
        }),
      ]);
      const dayStart = new Date(transition.dayStart).getTime();
      await createAppointment({
        masterId: offMaster!.id,
        serviceId: service.id,
        startsAt: new Date(dayStart - 15 * 60_000).toISOString(),
        endsAt: new Date(dayStart + 30 * 60_000).toISOString(),
      });
      const query = { serviceId: service.id, localDate: transition.localDate };

      await expect(
        dstScheduling.getMasterAvailability({ ...query, masterId: offMaster!.id }),
      ).resolves.toMatchObject({
        workingIntervals: [],
        freeIntervals: [],
        slots: [],
        dailyLoad: { bookedMinutes: 30, appointmentCount: 1 },
      });
      const combined = await dstScheduling.getAnyMasterAvailability(query);
      expect(slotStarts(combined)).toEqual([
        morningStart("00"),
        morningStart("15"),
        morningStart("30"),
      ]);
      expect(combined.slots.map(({ candidates }) => candidates.map(({ id }) => id))).toEqual([
        [workingMaster!.id],
        [workingMaster!.id],
        [workingMaster!.id],
      ]);
      expect(combined.masters.find(({ master }) => master.id === offMaster!.id)?.dailyLoad).toEqual(
        {
          bookedMinutes: 30,
          appointmentCount: 1,
        },
      );
      await expect(
        dstScheduling.selectAnyMaster({ ...query, startsAt: new Date(morningStart("00")) }),
      ).resolves.toMatchObject({ selectedMaster: { id: workingMaster!.id } });
    });

    it("replaces invalid weekly work with CUSTOM_HOURS and still subtracts weekly breaks", async () => {
      await configureBusiness("America/New_York");
      const { service, masters } = await createCatalogFixture();
      const master = masters[0]!;
      await addWeeklyWork(master.id, 7, transition.invalidStart, "03:30");
      await database.scheduleException.create({
        data: {
          masterId: master.id,
          localDate: databaseDate(transition.localDate),
          type: "CUSTOM_HOURS",
          intervals: {
            create: { startsAt: databaseTime("09:00"), endsAt: databaseTime("10:00") },
          },
        },
      });
      const query = {
        serviceId: service.id,
        masterId: master.id,
        localDate: transition.localDate,
      };

      expect(slotStarts(await dstScheduling.getMasterAvailability(query))).toEqual([
        morningStart("00"),
        morningStart("15"),
        morningStart("30"),
      ]);
      await addWeeklyBreak(master.id, 7, "09:15", "09:30");
      expect(slotStarts(await dstScheduling.getMasterAvailability(query))).toEqual([
        morningStart("30"),
      ]);
    });

    it.each(["weekly work", "custom work", "weekly break"])(
      "still rejects invalid boundaries of effective %s",
      async (source) => {
        await configureBusiness("America/New_York");
        const { service, masters } = await createCatalogFixture();
        const master = masters[0]!;

        if (source === "weekly work") {
          await addWeeklyWork(master.id, 7, transition.invalidStart, "03:30");
        } else {
          await database.scheduleException.create({
            data: {
              masterId: master.id,
              localDate: databaseDate(transition.localDate),
              type: "CUSTOM_HOURS",
              intervals: {
                create: {
                  startsAt: databaseTime(
                    source === "custom work" ? transition.invalidStart : "09:00",
                  ),
                  endsAt: databaseTime(source === "custom work" ? "03:30" : "10:00"),
                },
              },
            },
          });
          if (source === "weekly break") {
            await addWeeklyBreak(master.id, 7, transition.invalidStart, "03:00");
          }
        }

        await expect(
          dstScheduling.getMasterAvailability({
            serviceId: service.id,
            masterId: master.id,
            localDate: transition.localDate,
          }),
        ).rejects.toBeInstanceOf(InvalidLocalDateTimeError);
      },
    );
  });

  it("subtracts weekly breaks", async () => {
    await configureBusiness();
    const { service, masters } = await createCatalogFixture();
    const master = masters[0]!;
    await Promise.all([
      addWeeklyWork(master.id, 4, "09:00", "11:00"),
      addWeeklyBreak(master.id, 4, "10:00", "10:30"),
    ]);

    const result = await scheduling.getMasterAvailability({
      serviceId: service.id,
      masterId: master.id,
      localDate: "2026-10-08",
    });

    expect(slotStarts(result)).toEqual([
      "2026-10-08T06:00:00.000Z",
      "2026-10-08T06:15:00.000Z",
      "2026-10-08T06:30:00.000Z",
      "2026-10-08T07:30:00.000Z",
    ]);
  });

  it("blocks SCHEDULED, COMPLETED and NO_SHOW appointments", async () => {
    await configureBusiness();
    const { service, masters } = await createCatalogFixture();
    const master = masters[0]!;
    await addWeeklyWork(master.id, 5, "09:00", "13:00");
    await Promise.all([
      createAppointment({
        masterId: master.id,
        serviceId: service.id,
        startsAt: "2026-10-09T06:00:00.000Z",
        endsAt: "2026-10-09T06:30:00.000Z",
        status: "SCHEDULED",
      }),
      createAppointment({
        masterId: master.id,
        serviceId: service.id,
        startsAt: "2026-10-09T07:00:00.000Z",
        endsAt: "2026-10-09T07:30:00.000Z",
        status: "COMPLETED",
      }),
      createAppointment({
        masterId: master.id,
        serviceId: service.id,
        startsAt: "2026-10-09T08:00:00.000Z",
        endsAt: "2026-10-09T08:30:00.000Z",
        status: "NO_SHOW",
      }),
    ]);

    const result = await scheduling.getMasterAvailability({
      serviceId: service.id,
      masterId: master.id,
      localDate: "2026-10-09",
    });

    expect(slotStarts(result)).not.toContain("2026-10-09T06:00:00.000Z");
    expect(slotStarts(result)).not.toContain("2026-10-09T07:00:00.000Z");
    expect(slotStarts(result)).not.toContain("2026-10-09T08:00:00.000Z");
    expect(result.dailyLoad).toEqual({
      bookedMinutes: 90,
      appointmentCount: 3,
    });
  });

  it("releases an interval after its appointment becomes CANCELLED", async () => {
    await configureBusiness();
    const { service, masters } = await createCatalogFixture();
    const master = masters[0]!;
    await addWeeklyWork(master.id, 1, "09:00", "11:00");
    const appointment = await createAppointment({
      masterId: master.id,
      serviceId: service.id,
      startsAt: "2026-10-12T07:00:00.000Z",
      endsAt: "2026-10-12T07:30:00.000Z",
    });
    const query = {
      serviceId: service.id,
      masterId: master.id,
      localDate: "2026-10-12",
    };

    expect(slotStarts(await scheduling.getMasterAvailability(query))).not.toContain(
      "2026-10-12T07:00:00.000Z",
    );

    await database.appointment.update({
      where: { id: appointment.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date("2026-10-01T00:00:00.000Z"),
        cancelledBy: "SYSTEM",
      },
    });

    expect(slotStarts(await scheduling.getMasterAvailability(query))).toContain(
      "2026-10-12T07:00:00.000Z",
    );
  });

  it("converts the business local date to its exact UTC day", async () => {
    await configureBusiness("America/New_York");
    const { service, masters } = await createCatalogFixture();
    const master = masters[0]!;
    await addWeeklyWork(master.id, 7, "09:00", "10:00");

    const result = await scheduling.getMasterAvailability({
      serviceId: service.id,
      masterId: master.id,
      localDate: "2026-11-01",
    });

    expect(result.day).toEqual({
      startsAt: new Date("2026-11-01T04:00:00.000Z"),
      endsAt: new Date("2026-11-02T05:00:00.000Z"),
    });
    expect(result.workingIntervals).toEqual([
      {
        startsAt: new Date("2026-11-01T14:00:00.000Z"),
        endsAt: new Date("2026-11-01T15:00:00.000Z"),
      },
    ]);
  });

  it("omits fallback duplicates from any-master availability and interval rechecks", async () => {
    await configureBusiness("America/New_York");
    const { service, masters } = await createCatalogFixture({
      masterCount: 2,
      durationMinutes: 30,
    });
    const [first, second] = masters;
    await Promise.all([
      addWeeklyWork(first!.id, 7, "00:00", "04:00"),
      addWeeklyWork(second!.id, 7, "00:00", "04:00"),
    ]);

    const result = await scheduling.getAnyMasterAvailability({
      serviceId: service.id,
      localDate: "2026-11-01",
    });
    const starts = slotStarts(result);

    expect(starts).toEqual([
      "2026-11-01T04:00:00.000Z",
      "2026-11-01T04:15:00.000Z",
      "2026-11-01T04:30:00.000Z",
      "2026-11-01T04:45:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T07:15:00.000Z",
      "2026-11-01T07:30:00.000Z",
      "2026-11-01T07:45:00.000Z",
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T08:15:00.000Z",
      "2026-11-01T08:30:00.000Z",
    ]);
    expect(new Set(starts).size).toBe(starts.length);
    expect(result.slots.every(({ candidates }) => candidates.length === 2)).toBe(true);

    for (const startsAt of [
      new Date("2026-11-01T05:00:00.000Z"),
      new Date("2026-11-01T06:00:00.000Z"),
    ]) {
      await expect(
        scheduling.checkMasterInterval({
          serviceId: service.id,
          masterId: first!.id,
          localDate: "2026-11-01",
          startsAt,
        }),
      ).resolves.toMatchObject({ isAvailable: false, reason: "NOT_AVAILABLE" });
    }

    await expect(
      scheduling.checkMasterInterval({
        serviceId: service.id,
        masterId: first!.id,
        localDate: "2026-11-01",
        startsAt: new Date("2026-11-01T07:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ isAvailable: true, reason: "AVAILABLE" });
  });

  it("rechecks a selected interval and supports excludeAppointmentId", async () => {
    await configureBusiness();
    const { service, masters } = await createCatalogFixture();
    const master = masters[0]!;
    await addWeeklyWork(master.id, 2, "09:00", "12:00");
    const appointment = await createAppointment({
      masterId: master.id,
      serviceId: service.id,
      startsAt: "2026-10-13T07:00:00.000Z",
      endsAt: "2026-10-13T07:30:00.000Z",
    });
    const query = {
      serviceId: service.id,
      masterId: master.id,
      localDate: "2026-10-13",
      startsAt: new Date("2026-10-13T07:00:00.000Z"),
    };

    await expect(scheduling.checkMasterInterval(query)).resolves.toMatchObject({
      isAvailable: false,
      reason: "NOT_AVAILABLE",
    });
    await expect(
      scheduling.checkMasterInterval({
        ...query,
        excludeAppointmentId: appointment.id,
      }),
    ).resolves.toMatchObject({ isAvailable: true, reason: "AVAILABLE" });
  });

  it("returns merged availability with every free candidate", async () => {
    await configureBusiness();
    const { service, masters } = await createCatalogFixture({ masterCount: 2 });
    const [first, second] = masters;
    await Promise.all([
      addWeeklyWork(first!.id, 3, "09:00", "10:00"),
      addWeeklyWork(second!.id, 3, "09:30", "10:30"),
    ]);

    const result = await scheduling.getAnyMasterAvailability({
      serviceId: service.id,
      localDate: "2026-10-14",
    });
    const sharedSlot = result.slots.find(
      ({ startsAt }) => startsAt.toISOString() === "2026-10-14T06:30:00.000Z",
    );

    expect(result.masters).toHaveLength(2);
    expect(sharedSlot?.candidates.map(({ id }) => id)).toEqual([first!.id, second!.id]);
  });

  it("selects any master from free candidates using real daily load", async () => {
    await configureBusiness();
    const { service, masters } = await createCatalogFixture({
      masterCount: 3,
      masterDisplayOrders: [0, 1, 2],
    });
    const [oneAppointment, twoAppointments, busyAtSelectedTime] = masters;
    await Promise.all(masters.map((master) => addWeeklyWork(master.id, 4, "09:00", "13:00")));
    await Promise.all([
      createAppointment({
        masterId: oneAppointment!.id,
        serviceId: service.id,
        startsAt: "2026-10-15T06:00:00.000Z",
        endsAt: "2026-10-15T07:00:00.000Z",
      }),
      createAppointment({
        masterId: twoAppointments!.id,
        serviceId: service.id,
        startsAt: "2026-10-15T06:00:00.000Z",
        endsAt: "2026-10-15T06:30:00.000Z",
      }),
      createAppointment({
        masterId: twoAppointments!.id,
        serviceId: service.id,
        startsAt: "2026-10-15T07:00:00.000Z",
        endsAt: "2026-10-15T07:30:00.000Z",
      }),
      createAppointment({
        masterId: busyAtSelectedTime!.id,
        serviceId: service.id,
        startsAt: "2026-10-15T08:00:00.000Z",
        endsAt: "2026-10-15T08:30:00.000Z",
      }),
    ]);

    const result = await scheduling.selectAnyMaster({
      serviceId: service.id,
      localDate: "2026-10-15",
      startsAt: new Date("2026-10-15T08:00:00.000Z"),
    });

    expect(result.candidates.map(({ id }) => id)).toEqual([
      oneAppointment!.id,
      twoAppointments!.id,
    ]);
    expect(result.selectedMaster?.id).toBe(oneAppointment!.id);
    expect(result.selectedMaster?.dailyLoad).toEqual({
      bookedMinutes: 60,
      appointmentCount: 1,
    });
  });
});
