import "server-only";

import { getActiveAdmin } from "../../modules/auth/server/auth-service";
import {
  TelegramHealthSnapshotRepository,
  toTelegramHealthConfiguration,
} from "../../modules/telegram/server/health-snapshot";
import { parseTelegramRuntimeConfiguration } from "../../modules/telegram/server/runtime-config";
import { prisma } from "../db/prisma";
import { createAdminTelegramHealthBoundary } from "./telegram-health-boundary";

const snapshots = new TelegramHealthSnapshotRepository(prisma);

export const adminTelegramHealth = createAdminTelegramHealthBoundary({
  authorize: async (sessionToken) => (await getActiveAdmin(prisma, sessionToken)) !== null,
  configuration: () => toTelegramHealthConfiguration(parseTelegramRuntimeConfiguration()),
  snapshot: (configuration) => snapshots.getSnapshot(configuration),
});
