import "server-only";

import { parseTelegramWebConfiguration } from "../../modules/telegram/domain/config-contract";
import { AppointmentTelegramRepository } from "../../modules/telegram/server/appointment-connection-repository";
import { AppointmentTelegramService } from "../../modules/telegram/server/appointment-connection-service";
import { TelegramLinkRepository } from "../../modules/telegram/server/link-repository";
import { TelegramLinkService } from "../../modules/telegram/server/link-service";
import { prisma } from "../db/prisma";
import { createPublicTelegramLinkBoundary } from "./telegram-link-boundary";

const configuration = parseTelegramWebConfiguration({
  TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME,
});
const linkService = new TelegramLinkService(
  prisma,
  new TelegramLinkRepository(prisma, configuration),
);
const appointmentService = new AppointmentTelegramService(
  new AppointmentTelegramRepository(prisma, configuration),
);

export const publicTelegram = createPublicTelegramLinkBoundary(linkService, appointmentService);
