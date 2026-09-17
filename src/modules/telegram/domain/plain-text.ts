export function normalizeTelegramPlainText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "");
}
