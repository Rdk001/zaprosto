import { describe, expect, it } from "vitest";
import {
  rublesSchema,
  minutesInputSchema,
  saveServiceSchema,
  saveMasterSchema,
  moveCatalogSchema,
} from "./admin-input";

describe("административный ввод", () => {
  it.each([
    ["0.01", 1],
    ["0,1", 10],
    ["1.10", 110],
    ["12.34", 1234],
    ["1500", 150000],
    ["21474836,47", 2147483647],
    ["0001.01", 101],
  ])("точно переводит %s", (input, value) => {
    expect(rublesSchema.parse(input)).toBe(value);
  });
  it.each([
    "0",
    "0.00",
    "-1",
    "+1",
    ".50",
    "1.",
    "1.001",
    "1,001",
    "1e3",
    "NaN",
    "Infinity",
    "21474836.48",
    "999999999",
    " 1",
    "1 ",
    "1 000",
    "",
    "1,2.3",
  ])("отклоняет цену %s", (input) => {
    expect(rublesSchema.safeParse(input).success).toBe(false);
  });
  it("не требует кратности 15 и ограничивает тип PostgreSQL", () => {
    expect(minutesInputSchema.parse("35")).toBe(35);
    expect(minutesInputSchema.parse("2147483647")).toBe(2147483647);
    for (const value of ["0", "-1", "1.5", "1e3", "2147483648", " ", "1 "])
      expect(minutesInputSchema.safeParse(value).success).toBe(false);
  });
  const common = { target: null, name: "Стрижка", isActive: true, confirmDeactivation: false };
  it("строгие схемы запрещают неожиданные поля, ID, длинные строки и массивы", () => {
    const service = { ...common, priceRubles: "1", durationMinutes: "35" };
    const master = { ...common, description: "", serviceIds: [] };
    expect(saveServiceSchema.safeParse({ ...service, displayOrder: 5 }).success).toBe(false);
    expect(
      saveServiceSchema.safeParse({ ...service, target: { id: "bad", version: 0 } }).success,
    ).toBe(false);
    expect(saveServiceSchema.safeParse({ ...service, name: "a".repeat(161) }).success).toBe(false);
    expect(saveMasterSchema.safeParse({ ...master, photoMediaId: "fake" }).success).toBe(false);
    expect(saveMasterSchema.safeParse({ ...master, description: "a".repeat(2001) }).success).toBe(
      false,
    );
    expect(
      saveMasterSchema.safeParse({
        ...master,
        serviceIds: Array(101).fill("6d9e7609-8d5f-4bc5-843d-4ce29ddad567"),
      }).success,
    ).toBe(false);
    expect(
      saveMasterSchema.safeParse({
        ...master,
        serviceIds: Array(2).fill("6d9e7609-8d5f-4bc5-843d-4ce29ddad567"),
      }).success,
    ).toBe(false);
    expect(
      moveCatalogSchema.safeParse({
        kind: "services",
        id: "bad",
        direction: "up",
        orderVersion: "bad",
      }).success,
    ).toBe(false);
  });
  it("HTML остаётся обычным текстом; пустые имена запрещены", () => {
    const master = {
      ...common,
      name: "<script>alert(1)</script>",
      description: "<b>Текст</b>",
      serviceIds: [],
    };
    expect(saveMasterSchema.parse(master).name).toBe(master.name);
    expect(saveMasterSchema.safeParse({ ...master, name: "   " }).success).toBe(false);
  });
});
