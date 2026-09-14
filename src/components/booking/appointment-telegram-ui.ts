export type AppointmentTelegramUiState = "AVAILABLE" | "CONNECTED" | "UNAVAILABLE";

export type AppointmentTelegramClientLink = Readonly<{
  forToken: string;
  url: string;
  expiresAt: Date;
}>;

export function isCurrentTelegramRequest(request: number, current: number): boolean {
  return request === current;
}

export function visibleTelegramLink(
  link: AppointmentTelegramClientLink | null,
  token: string,
): AppointmentTelegramClientLink | null {
  return link?.forToken === token ? link : null;
}

export function readIssuedTelegramLink(
  value: { deepLink: unknown; expiresAt: unknown },
  token: string,
): AppointmentTelegramClientLink | null {
  if (typeof value.deepLink !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.deepLink);
  } catch {
    return null;
  }
  const start = url.searchParams.get("start");
  const expiresAt =
    value.expiresAt instanceof Date ? value.expiresAt : new Date(String(value.expiresAt));
  if (
    url.protocol !== "https:" ||
    url.hostname !== "t.me" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    url.searchParams.size !== 1 ||
    !/^\/[A-Za-z][A-Za-z0-9_]{4,31}$/.test(url.pathname) ||
    !/^c_[A-Za-z0-9_-]{43}$/.test(start ?? "") ||
    !Number.isFinite(expiresAt.getTime())
  )
    return null;
  return { forToken: token, url: url.toString(), expiresAt };
}

export type TelegramIssueFailureUi = Readonly<{
  nextState?: AppointmentTelegramUiState;
  refresh: boolean;
  message: string;
}>;

export function mapTelegramIssueFailure(code: string): TelegramIssueFailureUi {
  switch (code) {
    case "ALREADY_CONNECTED":
      return {
        refresh: true,
        message: "Проверяем подтверждённое подключение…",
      };
    case "APPOINTMENT_NOT_ELIGIBLE":
    case "TELEGRAM_NOT_READY":
      return {
        nextState: "UNAVAILABLE",
        refresh: false,
        message: "",
      };
    case "RATE_LIMITED":
      return {
        refresh: false,
        message: "Слишком много попыток. Немного подождите и попробуйте снова.",
      };
    default:
      return {
        refresh: true,
        message: "Результат не удалось подтвердить. Обновите статус перед повтором.",
      };
  }
}
