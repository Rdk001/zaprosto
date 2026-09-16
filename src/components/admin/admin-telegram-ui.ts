export type AdminTelegramUiState = "AVAILABLE" | "CONNECTED" | "UNAVAILABLE";

export type AdminTelegramClientLink = Readonly<{
  url: string;
  expiresAt: Date;
}>;

export type AdminTelegramUiModel = Readonly<{
  state: AdminTelegramUiState | null;
  link: null;
  confirmingDisconnect: false;
}>;

export function createAdminTelegramUiModel(
  initialState: AdminTelegramUiState | null,
): AdminTelegramUiModel {
  return { state: initialState, link: null, confirmingDisconnect: false };
}

export function isCurrentAdminTelegramRequest(request: number, current: number): boolean {
  return request === current;
}

export function readIssuedAdminTelegramLink(value: {
  deepLink: unknown;
  expiresAt: unknown;
}): AdminTelegramClientLink | null {
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
    !/^a_[A-Za-z0-9_-]{43}$/.test(start ?? "") ||
    !Number.isFinite(expiresAt.getTime())
  )
    return null;
  return { url: url.toString(), expiresAt };
}

export type AdminTelegramIssueFailureUi = Readonly<{
  nextState?: AdminTelegramUiState;
  refresh: boolean;
  unauthorized: boolean;
  message: string;
}>;

export function mapAdminTelegramIssueFailure(code: string): AdminTelegramIssueFailureUi {
  switch (code) {
    case "UNAUTHORIZED":
      return { refresh: false, unauthorized: true, message: "" };
    case "ALREADY_CONNECTED":
      return {
        refresh: true,
        unauthorized: false,
        message: "Проверяем подтверждённое подключение…",
      };
    case "TELEGRAM_NOT_READY":
      return {
        nextState: "UNAVAILABLE",
        refresh: false,
        unauthorized: false,
        message: "Telegram временно недоступен. Попробуйте обновить статус позже.",
      };
    case "RATE_LIMITED":
      return {
        refresh: false,
        unauthorized: false,
        message: "Слишком много попыток. Немного подождите и попробуйте снова.",
      };
    default:
      return {
        refresh: true,
        unauthorized: false,
        message: "Результат не удалось подтвердить. Обновите статус перед повтором.",
      };
  }
}
