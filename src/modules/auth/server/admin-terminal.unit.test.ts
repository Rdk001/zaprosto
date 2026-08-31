import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { expect, it, vi } from "vitest";
import { readTerminalLine } from "../../../../scripts/admin-terminal";
function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(),
  });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let printed = "";
  output.on("data", (data) => {
    printed += data.toString();
  });
  return { input, output, printed: () => printed };
}
it("пароль скрыт, backspace работает, raw mode восстановлен", async () => {
  const t = terminal();
  const result = readTerminalLine(
    "Пароль: ",
    true,
    128,
    t.input as unknown as ReadStream,
    t.output as unknown as WriteStream,
  );
  t.input.emit("keypress", "hidden-passwordX", {});
  t.input.emit("keypress", undefined, { name: "backspace" });
  t.input.emit("keypress", "\r", { name: "return" });
  expect(await result).toBe("hidden-password");
  expect(t.printed()).toBe("Пароль: \n");
  expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
  expect(t.input.listenerCount("keypress")).toBe(0);
});
it.each(["cancel", "overflow", "end"])(
  "прерывание %s не раскрывает ввод и восстанавливает терминал",
  async (mode) => {
    const t = terminal();
    const result = readTerminalLine(
      "Пароль: ",
      true,
      12,
      t.input as unknown as ReadStream,
      t.output as unknown as WriteStream,
    );
    if (mode === "cancel") t.input.emit("keypress", undefined, { name: "c", ctrl: true });
    if (mode === "overflow") t.input.emit("keypress", "a".repeat(13), {});
    if (mode === "end") t.input.emit("end");
    await expect(result).rejects.toThrow();
    expect(t.printed()).toBe("Пароль: \n");
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
  },
);
it("pipe запрещён до чтения", async () => {
  const t = terminal();
  t.input.isTTY = false;
  await expect(
    readTerminalLine(
      "Пароль: ",
      true,
      128,
      t.input as unknown as ReadStream,
      t.output as unknown as WriteStream,
    ),
  ).rejects.toThrow("TTY");
  expect(t.printed()).toBe("");
});
