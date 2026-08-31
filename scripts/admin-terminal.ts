import { emitKeypressEvents, type Key } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

// No readline output/echo for secrets, not even asterisks. Never accept piped stdin.
export function readTerminalLine(
  label: string,
  hidden: boolean,
  maximum: number,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Promise<string> {
  if (!input.isTTY || !output.isTTY)
    return Promise.reject(new Error("Нужен интерактивный терминал TTY."));
  output.write(label);
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    function finish(error?: Error) {
      input.off("keypress", keypress);
      input.off("end", ended);
      input.off("error", failed);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      if (error) {
        value = "";
        reject(error);
      } else {
        const result = value;
        value = "";
        resolve(result);
      }
    }
    function ended() {
      finish(new Error("Ввод прерван."));
    }
    function failed() {
      finish(new Error("Ошибка терминала."));
    }
    function keypress(text: string | undefined, key: Key) {
      if (key.ctrl && (key.name === "c" || key.name === "d")) return ended();
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
        if (!hidden) output.write("\b \b");
        return;
      }
      if (key.ctrl || key.meta || !text || /[\x00-\x1f\x7f]/.test(text)) return;
      if (value.length + text.length > maximum) return finish(new Error("Ввод слишком длинный."));
      value += text;
      if (!hidden) output.write(text);
    }
    input.on("keypress", keypress);
    input.once("end", ended);
    input.once("error", failed);
  });
}
