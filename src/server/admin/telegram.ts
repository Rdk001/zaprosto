import "server-only";

import { cookies } from "next/headers";

import { sessionCookie } from "../../modules/auth/policy";
import { parseTelegramWebConfiguration } from "../../modules/telegram/domain/config-contract";
import { AdminTelegramRepository } from "../../modules/telegram/server/admin-connection-repository";
import { AdminTelegramService } from "../../modules/telegram/server/admin-connection-service";
import { TelegramLinkRepository } from "../../modules/telegram/server/link-repository";
import { TelegramLinkService } from "../../modules/telegram/server/link-service";
import { prisma } from "../db/prisma";
import { createAdminTelegramLinkBoundary } from "./telegram-link-boundary";

const configuration = parseTelegramWebConfiguration({
  TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME,
});
const links = new TelegramLinkService(prisma, new TelegramLinkRepository(prisma, configuration));
const connections = new AdminTelegramService(
  prisma,
  new AdminTelegramRepository(prisma, configuration),
);

export const adminTelegram = createAdminTelegramLinkBoundary(links, connections);

export async function getAdminTelegramState() {
  try {
    const cookie = sessionCookie();
    return await adminTelegram.state((await cookies()).get(cookie.name)?.value);
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
