export function money(kopecks: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 2,
  }).format(kopecks / 100);
}
export function time(value: Date | string, timeZone: string) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit" }).format(
    new Date(value),
  );
}
export function dateTime(value: Date | string, timeZone: string) {
  return (
    new Intl.DateTimeFormat("ru-RU", {
      timeZone,
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(value)) +
    ", " +
    time(value, timeZone)
  );
}
export function calendarDate(value: string, short = false) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    day: "numeric",
    month: short ? "short" : "long",
    weekday: "short",
  }).format(new Date(value + "T12:00:00Z"));
}
