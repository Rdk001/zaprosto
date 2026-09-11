import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../../generated/prisma/client";
import { prepareBookingAttempt } from "../../booking/server/booking-security";
import type { TelegramLinkStore } from "./link-repository";
import { TelegramLinkService, TelegramLinkServiceError } from "./link-service";

const adminId = "00000000-0000-4000-8000-000000000001";
const expiresAt = new Date("2032-02-01T08:30:00.000Z");

function setup(admin: { id: string; login: string } | null = { id: adminId, login: "admin" }) {
  const store: TelegramLinkStore = {
    issueAppointment: vi.fn(async () => ({
      kind: "ISSUED" as const,
      expiresAt,
      botUsername: "Zaprosto_Test_Bot",
    })),
    revokeAppointment: vi.fn(async () => ({ kind: "REVOKED" as const })),
    issueAdmin: vi.fn(async () => ({
      kind: "ISSUED" as const,
      expiresAt,
      botUsername: "Zaprosto_Test_Bot",
    })),
    revokeAdmin: vi.fn(async () => ({ kind: "REVOKED" as const })),
  };
  const service = new TelegramLinkService({} as PrismaClient, store, {
    randomSource: (size) => new Uint8Array(size).fill(0xab),
    readActiveAdmin: vi.fn(async () => admin),
  });
  return { service, store };
}

describe("Telegram link service", () => {
  it("returns one direct client t.me URL and gives the repository only hashes", async () => {
    const { service, store } = setup();
    const cancellationToken = prepareBookingAttempt().cancellationToken;
    const result = await service.issueAppointmentLink(cancellationToken);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.deepLink);
    const raw = url.searchParams.get("start");
    expect(url.origin).toBe("https://t.me");
    expect(url.pathname).toBe("/Zaprosto_Test_Bot");
    expect(raw).toMatch(/^c_[A-Za-z0-9_-]{43}$/);
    expect(result.expiresAt).toEqual(expiresAt);
    const call = vi.mocked(store.issueAppointment).mock.calls[0]![0];
    expect(call.cancellationTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(call.linkTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(call)).not.toContain(raw!);
    expect(result.deepLink).not.toContain("redirect");
  });

  it("uses a_ and the server-side current admin without accepting an id", async () => {
    const { service, store } = setup();
    const result = await service.issueAdminLink("session-canary");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new URL(result.deepLink).searchParams.get("start")).toMatch(/^a_[A-Za-z0-9_-]{43}$/);
    expect(vi.mocked(store.issueAdmin).mock.calls[0]![0]).toMatchObject({
      adminUserId: adminId,
      sessionToken: "session-canary",
    });
    expect(vi.mocked(store.issueAdmin).mock.calls[0]![0].linkTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects malformed/unknown authorization before repository mutation", async () => {
    const { service, store } = setup(null);
    await expect(service.issueAppointmentLink("malformed")).resolves.toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    await expect(service.revokeAppointmentLink("malformed")).resolves.toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    await expect(service.issueAdminLink("bad-session")).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
    expect(store.issueAppointment).not.toHaveBeenCalled();
    expect(store.revokeAppointment).not.toHaveBeenCalled();
    expect(store.issueAdmin).not.toHaveBeenCalled();
  });

  it("does not return a link when repository readiness is unavailable", async () => {
    const { store } = setup();
    vi.mocked(store.issueAppointment).mockResolvedValueOnce({ kind: "TELEGRAM_NOT_READY" });
    vi.mocked(store.issueAdmin).mockResolvedValueOnce({ kind: "TELEGRAM_NOT_READY" });
    const service = new TelegramLinkService({} as PrismaClient, store, {
      readActiveAdmin: vi.fn(async () => ({ id: adminId, login: "admin" })),
    });
    await expect(
      service.issueAppointmentLink(prepareBookingAttempt().cancellationToken),
    ).resolves.toEqual({ ok: false, code: "TELEGRAM_NOT_READY" });
    await expect(service.issueAdminLink("session")).resolves.toEqual({
      ok: false,
      code: "TELEGRAM_NOT_READY",
    });
    expect(store.issueAppointment).toHaveBeenCalledOnce();
    expect(store.issueAdmin).toHaveBeenCalledOnce();
  });

  it("uses safe errors for an admin lookup failure", async () => {
    const canary = "SESSION_DATABASE_CANARY";
    const { store } = setup();
    const service = new TelegramLinkService({} as PrismaClient, store, {
      readActiveAdmin: vi.fn(async () => {
        throw new Error(canary);
      }),
    });
    const error = await service.issueAdminLink(canary).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TelegramLinkServiceError);
    expect(JSON.stringify(error)).toBe(
      '{"name":"TelegramLinkServiceError","code":"LINK_UNAVAILABLE"}',
    );
    expect(JSON.stringify(error)).not.toContain(canary);
  });
});
