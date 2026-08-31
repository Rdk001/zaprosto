import { describe, expect, it } from "vitest";
import { prepareBookingAttempt } from "../server/booking-security";
import {
  ATTEMPT_STORAGE_KEY,
  CONTACT_TTL_MS,
  readAttempt,
  writeAttempt,
  type SavedAttempt,
} from "./attempt-storage";
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (k) => values.get(k) ?? null,
    key: (n) => [...values.keys()][n] ?? null,
    removeItem: (k) => {
      values.delete(k);
    },
    setItem: (k, v) => {
      values.set(k, v);
    },
  };
}
const input = {
  ...prepareBookingAttempt(),
  serviceId: "de000000-0000-4000-8000-000000000001",
  master: { type: "ANY" as const },
  localDate: "2026-09-01",
  startsAt: "2026-09-01T10:00:00+03:00",
  clientName: "Вымышленный",
  clientPhone: "8 (999) 000-00-00",
};
describe("жизненный цикл попытки", () => {
  it("сохраняет исходный запрос без нормализации и возвращает после reload", () => {
    const s = storage();
    const pending: SavedAttempt = { state: "pending", input, savedAt: 100 };
    writeAttempt(s, pending);
    expect(readAttempt(s, 200)).toEqual(pending);
  });
  it("удаляет контакты по TTL, оставляя блокировку новой записи и секрет проверки", () => {
    const s = storage();
    writeAttempt(s, { state: "pending", input, savedAt: 100 });
    expect(readAttempt(s, 100 + CONTACT_TTL_MS)).toEqual({
      state: "expired",
      token: input.cancellationToken,
    });
    expect(s.getItem(ATTEMPT_STORAGE_KEY)).not.toContain(input.clientPhone);
    expect(s.getItem(ATTEMPT_STORAGE_KEY)).not.toContain(input.clientName);
  });
  it("повреждённый формат не превращается в новую попытку", () => {
    const s = storage();
    s.setItem(ATTEMPT_STORAGE_KEY, "{broken");
    expect(readAttempt(s)).toEqual({ state: "damaged" });
  });
  it("ошибка записи хранилища запрещает отправку", () => {
    const s = storage();
    s.setItem = () => {
      throw new Error("quota");
    };
    expect(() => writeAttempt(s, { state: "pending", input, savedAt: 100 })).toThrow();
  });
});

it("новый отпечаток сохраняется как часть исходной попытки; старый формат не дополняется", () => {
  for (const payload of [input, { ...input, expectedServiceTerms: "a".repeat(64) }]) {
    const s = storage();
    const pending: SavedAttempt = { state: "pending", savedAt: 100, input: payload };
    writeAttempt(s, pending);
    expect(readAttempt(s, 200)).toEqual(pending);
    expect(JSON.parse(s.getItem(ATTEMPT_STORAGE_KEY)!).input).toEqual(payload);
  }
});
it("невалидный отпечаток в сохранённой попытке сохраняет блокировку неизвестного исхода", () => {
  const s = storage();
  s.setItem(
    ATTEMPT_STORAGE_KEY,
    JSON.stringify({
      state: "pending",
      savedAt: 100,
      input: { ...input, expectedServiceTerms: "" },
    }),
  );
  expect(readAttempt(s, 200)).toEqual({ state: "damaged" });
});
