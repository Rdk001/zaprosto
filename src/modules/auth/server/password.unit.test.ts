import { expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";
it("Argon2id: разные соли, политика и реальная проверка", async () => {
  const one = await hashPassword("test-only passphrase");
  const two = await hashPassword("test-only passphrase");
  expect(one).not.toBe(two);
  expect(one.startsWith("$argon2id$v=19$")).toBe(true);
  expect(one.split("$")[3].split(",").sort()).toEqual(["m=65536", "p=1", "t=3"]);
  expect(await verifyPassword("test-only passphrase", one)).toBe(true);
  expect(await verifyPassword("wrong-only passphrase", one)).toBe(false);
  expect(await verifyPassword("test-only passphrase")).toBe(false);
  expect(await verifyPassword("test-only passphrase", "damaged")).toBe(false);
});
