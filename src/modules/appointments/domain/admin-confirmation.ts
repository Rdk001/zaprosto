import type { AppointmentConfirmation } from "../server/confirmation";

function oneLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildAdminConfirmationText(input: {
  confirmation: AppointmentConfirmation;
  timeZone: string;
  protectedUrl: string;
}): string {
  const { confirmation, timeZone } = input;
  const when = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone,
  }).format(confirmation.startsAt);
  return [
    "Ваша запись подтверждена.",
    `Услуга: ${oneLine(confirmation.service.name)}`,
    `Мастер: ${oneLine(confirmation.master.name)}`,
    `Дата и время: ${when} (${oneLine(timeZone)})`,
    `Ссылка для просмотра и отмены: ${oneLine(input.protectedUrl)}`,
    "Не передавайте эту ссылку посторонним: она даёт доступ к сведениям о записи и её отмене.",
  ].join("\n");
}
