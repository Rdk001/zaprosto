import type {
  TelegramHealthConfiguration,
  TelegramHealthSnapshot,
} from "../../modules/telegram/server/health-snapshot";

export type AdminTelegramHealthResult =
  | Readonly<{ ok: true; snapshot: TelegramHealthSnapshot }>
  | Readonly<{
      ok: false;
      code: "UNAUTHORIZED" | "UNAVAILABLE" | "TELEGRAM_HEALTH_STORAGE_FAILURE";
    }>;

export function createAdminTelegramHealthBoundary(dependencies: {
  authorize: (sessionToken: unknown) => Promise<boolean>;
  snapshot: (configuration: TelegramHealthConfiguration) => Promise<TelegramHealthSnapshot>;
  configuration: () => TelegramHealthConfiguration;
}) {
  return {
    async read(sessionToken: unknown): Promise<AdminTelegramHealthResult> {
      try {
        if (!(await dependencies.authorize(sessionToken))) {
          return { ok: false, code: "UNAUTHORIZED" };
        }
      } catch {
        return { ok: false, code: "UNAVAILABLE" };
      }

      try {
        return {
          ok: true,
          snapshot: await dependencies.snapshot(dependencies.configuration()),
        };
      } catch {
        return { ok: false, code: "TELEGRAM_HEALTH_STORAGE_FAILURE" };
      }
    },
  };
}
