import { describe, expect, it } from "vitest";

import { buildAdminConfirmationText } from "./admin-confirmation";

describe("admin confirmation text", () => {
  it("includes the visit and protected link as plain injection-safe text", () => {
    const text = buildAdminConfirmationText({
      timeZone: "Europe/Moscow",
      protectedUrl: "https://example.test/appointment#secret",
      confirmation: {
        id: "appointment",
        status: "SCHEDULED",
        startsAt: new Date("2026-10-05T07:00:00Z"),
        endsAt: new Date("2026-10-05T07:30:00Z"),
        clientName: "Клиент",
        clientPhone: "+79990000000",
        master: { id: "master", name: "Мастер\n<script>alert(1)</script>" },
        service: {
          id: "service",
          name: "Услуга\r\n<img src=x onerror=alert(1)>",
          priceKopecks: 100_000,
          durationMinutes: 30,
        },
        cancelledAt: null,
        cancelledBy: null,
        cancellationReason: null,
      },
    });
    expect(text).toContain("Услуга: Услуга ‹img src=x onerror=alert(1)›");
    expect(text).toContain("Мастер: Мастер ‹script›alert(1)‹/script›");
    expect(text).toContain("5 октября 2026");
    expect(text).toContain("10:00");
    expect(text).toContain("https://example.test/appointment#secret");
    expect(text).toContain("Не передавайте эту ссылку посторонним");
    expect(text).not.toMatch(/<\/?(?:script|img)/i);
    expect(text).not.toContain("\r");
  });
});
