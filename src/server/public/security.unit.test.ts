import { describe, expect, it } from "vitest";
import { clientIdentity, validOrigin } from "./security";
describe("публичный источник и proxy", () => {
  it("требует точный Origin и отклоняет отсутствующий, null и cross-site", () => {
    for (const origin of [
      undefined,
      "null",
      "https://evil.example",
      "https://book.example.evil",
      "http://book.example",
    ])
      expect(validOrigin(new Headers(origin ? { origin } : {}), "https://book.example")).toBe(
        false,
      );
    expect(
      validOrigin(new Headers({ origin: "https://book.example" }), "https://book.example"),
    ).toBe(true);
    expect(
      validOrigin(
        new Headers({ origin: "https://book.example", "sec-fetch-site": "cross-site" }),
        "https://book.example",
      ),
    ).toBe(false);
    expect(
      validOrigin(
        new Headers({
          origin: "https://book.example",
          host: "book.example",
          "x-forwarded-host": "evil.example",
        }),
        "https://book.example",
      ),
    ).toBe(true);
  });
  it("не доверяет произвольным forwarded заголовкам", () => {
    const headers = new Headers({
      "x-forwarded-for": "1.2.3.4",
      "x-real-ip": "1.2.3.4",
      "x-zaprosto-client-ip": "1.2.3.4",
    });
    expect(clientIdentity(headers, false)).toBe("shared");
    expect(clientIdentity(headers, true)).toMatch(/^[a-f0-9]{64}$/);
    expect(clientIdentity(new Headers({ "x-zaprosto-client-ip": "1.2.3.4, 5.6.7.8" }), true)).toBe(
      "shared",
    );
    expect(clientIdentity(new Headers({ "x-zaprosto-client-ip": "::1" }), true)).toBe(
      clientIdentity(new Headers({ "x-zaprosto-client-ip": "0:0:0:0:0:0:0:1" }), true),
    );
  });
});
