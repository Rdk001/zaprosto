import { describe, expect, it } from "vitest";

import { generateTelegramLinkToken, hashTelegramLinkToken } from "../domain/link-token";
import type { TelegramUpdate } from "./bot-api";
import { parseTelegramStartCommand } from "./start-command-parser";

const USERNAME = "Zaprosto_Test_Bot";
const CLIENT_TOKEN = generateTelegramLinkToken("APPOINTMENT", (size) =>
  new Uint8Array(size).fill(0x11),
).startParameter;
const ADMIN_TOKEN = generateTelegramLinkToken("ADMIN_USER", (size) =>
  new Uint8Array(size).fill(0x22),
).startParameter;

function update(text?: string): TelegramUpdate {
  return {
    updateId: 42n,
    message: {
      messageId: 7n,
      from: { id: 101n, isBot: false },
      dateUnixSeconds: 1_800_000_000,
      chat: { id: 101n, type: "private" },
      ...(text === undefined ? {} : { text }),
    },
  };
}

describe("Telegram /start parser", () => {
  it("принимает только точную bare-команду", () => {
    expect(parseTelegramStartCommand(update(`/start ${CLIENT_TOKEN}`), USERNAME)).toMatchObject({
      kind: "PARSED",
      value: { updateId: 42n, telegramUserId: 101n, telegramChatId: 101n, purpose: "APPOINTMENT" },
    });
  });

  it("принимает точную addressed-команду и username без учёта регистра", () => {
    expect(
      parseTelegramStartCommand(update(`/start@zApRoStO_tEsT_bOt ${ADMIN_TOKEN}`), USERNAME),
    ).toMatchObject({ kind: "PARSED", value: { purpose: "ADMIN_USER" } });
  });

  it("игнорирует другой bot username", () => {
    expect(
      parseTelegramStartCommand(update(`/start@Another_Bot ${CLIENT_TOKEN}`), USERNAME),
    ).toEqual({ kind: "IGNORED" });
  });

  it.each([
    ` /start ${CLIENT_TOKEN}`,
    `/start  ${CLIENT_TOKEN}`,
    `/start ${CLIENT_TOKEN} `,
    `/start ${CLIENT_TOKEN} extra`,
    `/start\t${CLIENT_TOKEN}`,
    `/start ${CLIENT_TOKEN}\n`,
    `/start ${CLIENT_TOKEN}\r\nextra`,
  ])("игнорирует неоднозначный whitespace/arguments: %j", (text) => {
    expect(parseTelegramStartCommand(update(text), USERNAME)).toEqual({ kind: "IGNORED" });
  });

  it.each(["group", "supergroup", "channel"] as const)("игнорирует chat type %s", (type) => {
    const value = update(`/start ${CLIENT_TOKEN}`);
    value.message!.chat.type = type;
    expect(parseTelegramStartCommand(value, USERNAME)).toEqual({ kind: "IGNORED" });
  });

  it("игнорирует сообщения от бота", () => {
    const value = update(`/start ${CLIENT_TOKEN}`);
    value.message!.from!.isBot = true;
    expect(parseTelegramStartCommand(value, USERNAME)).toEqual({ kind: "IGNORED" });
  });

  it("игнорирует отсутствующие message/from/text", () => {
    const withoutFrom = update(`/start ${CLIENT_TOKEN}`);
    delete withoutFrom.message!.from;
    expect(parseTelegramStartCommand({ updateId: 1n }, USERNAME)).toEqual({ kind: "IGNORED" });
    expect(parseTelegramStartCommand(withoutFrom, USERNAME)).toEqual({ kind: "IGNORED" });
    expect(parseTelegramStartCommand(update(), USERNAME)).toEqual({ kind: "IGNORED" });
  });

  it("игнорирует несовпадающие и неположительные private IDs", () => {
    const mismatch = update(`/start ${CLIENT_TOKEN}`);
    mismatch.message!.chat.id = 102n;
    const nonPositive = update(`/start ${CLIENT_TOKEN}`);
    nonPositive.message!.from!.id = 0n;
    nonPositive.message!.chat.id = 0n;
    expect(parseTelegramStartCommand(mismatch, USERNAME)).toEqual({ kind: "IGNORED" });
    expect(parseTelegramStartCommand(nonPositive, USERNAME)).toEqual({ kind: "IGNORED" });
  });

  it.each(["bad", `x_${CLIENT_TOKEN.slice(2)}`, `${CLIENT_TOKEN.slice(0, -1)}B`])(
    "игнорирует malformed start parameter: %s",
    (token) => {
      expect(parseTelegramStartCommand(update(`/start ${token}`), USERNAME)).toEqual({
        kind: "IGNORED",
      });
    },
  );

  it("возвращает только hash и безопасные поля, но не raw token", () => {
    const result = parseTelegramStartCommand(update(`/start ${CLIENT_TOKEN}`), USERNAME);
    const expected = hashTelegramLinkToken(CLIENT_TOKEN);
    if (result.kind !== "PARSED" || !expected.ok) throw new Error("Expected parsed test command");
    expect(Object.keys(result.value).sort()).toEqual([
      "purpose",
      "telegramChatId",
      "telegramUserId",
      "tokenHash",
      "updateId",
    ]);
    expect(result.value.tokenHash).toBe(expected.hash);
    const serialized = JSON.stringify(result, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain(CLIENT_TOKEN);
  });
});
