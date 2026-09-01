import { expect, it } from "vitest";
import {
  allowedTransition,
  statusTimeAllowed,
  journalQuerySchema,
  detailQuerySchema,
  changeStatusSchema,
  journalHref,
} from "./admin-input";
import { getLocalDayInterval } from "../../scheduling/time/business-time";

it.each([
  ["SCHEDULED", ["CANCELLED", "COMPLETED", "NO_SHOW"]],
  ["COMPLETED", ["NO_SHOW"]],
  ["NO_SHOW", ["COMPLETED"]],
  ["CANCELLED", []],
] as const)("transition matrix %s", (from, allowed) => {
  for (const next of ["SCHEDULED", "COMPLETED", "NO_SHOW", "CANCELLED"] as const)
    expect(allowedTransition(from, next)).toBe((allowed as readonly string[]).includes(next));
});
it("strict filters, calendar dates and bounded page numbers", () => {
  expect(journalQuerySchema.parse({})).toEqual({ status: "ACTIVE", page: 1 });
  for (const date of ["1900-01-01", "2099-12-31", "2028-02-29"])
    expect(journalQuerySchema.safeParse({ date }).success).toBe(true);
  for (const bad of [
    { date: "2026-02-29" },
    { page: "0" },
    { page: "-1" },
    { page: "1.5" },
    { page: "10000000" },
    { page: ["1", "2"] },
    { masterId: "bad" },
    { status: "unknown" },
    { clientName: "private" },
  ])
    expect(journalQuerySchema.safeParse(bad).success).toBe(false);
  expect(detailQuerySchema.safeParse({ historyPage: "0" }).success).toBe(false);
});
it("strict mutation: version, context, actor and reason", () => {
  const input = {
    id: "10000000-0000-4000-8000-000000000001",
    version: 0,
    expectedBusinessContext: "a".repeat(64),
    status: "CANCELLED",
    confirmed: true,
  };
  expect(changeStatusSchema.safeParse(input).success).toBe(true);
  for (const extra of [
    { id: "bad" },
    { version: "0" },
    { version: -1 },
    { version: 2147483648 },
    { status: "oops" },
    { confirmed: "true" },
    { confirmed: undefined },
    { reason: "x".repeat(1001) },
    { changedBy: "CLIENT" },
    { changedByAdminId: input.id },
    { expectedBusinessContext: undefined },
  ])
    expect(changeStatusSchema.safeParse({ ...input, ...extra }).success).toBe(false);
});
it.each([
  ["2026-03-29", 23],
  ["2026-10-25", 25],
] as const)("DST day %s", (date, hours) => {
  const day = getLocalDayInterval(date, "Europe/Berlin");
  expect((day.endsAt.getTime() - day.startsAt.getTime()) / 3600000).toBe(hours);
});
it("navigation preserves only allowed filters, pagination and history", () => {
  const q = {
    date: "2026-01-15",
    status: "CANCELLED" as const,
    page: 2,
    masterId: "10000000-0000-4000-8000-000000000001",
  };
  const href = journalHref(q, q.masterId, 3);
  const url = new URL(href, "https://example.test");
  expect(Object.fromEntries(url.searchParams)).toEqual({ ...q, page: "2", historyPage: "3" });
});

it("exact visit start, adjacent milliseconds, cancellation without a deadline", () => {
  const startsAt = new Date("2026-01-15T07:00:00Z");
  for (const status of ["COMPLETED", "NO_SHOW"] as const) {
    expect(statusTimeAllowed(status, startsAt, new Date(startsAt.getTime() - 1))).toBe(false);
    expect(statusTimeAllowed(status, startsAt, startsAt)).toBe(true);
    expect(statusTimeAllowed(status, startsAt, new Date(startsAt.getTime() + 1))).toBe(true);
  }
  expect(statusTimeAllowed("CANCELLED", startsAt, new Date(0))).toBe(true);
});
